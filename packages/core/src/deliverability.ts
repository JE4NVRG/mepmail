import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle that imports this
// module's thresholds. The type-only Db import above is erased.
import * as schema from "@millionsend/db/schema";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import { DAY_MS } from "./utc-day.js";

/** Internal MepMail anti-abuse policy, NOT provider limits or guarantees.
 * Warning and pause both use an exact rolling 24-hour window (start, end].
 * Pause is strictly above the line; equality warns but does not pause.
 */
export const WARN_BOUNCE_RATE = 0.015;
export const WARN_COMPLAINT_RATE = 0.0005;
export const PAUSE_BOUNCE_RATE = 0.02;
export const PAUSE_COMPLAINT_RATE = 0.0008;
/** Warning-only anti-noise floor. It must not exempt trial senders from pauses. */
export const MIN_GUARDRAIL_VOLUME = 100;
export const MIN_PAUSE_COMPLAINTS = 1;
export const MIN_PAUSE_HARD_BOUNCES = 1;
export const MIN_WARN_COMPLAINTS = 1;
/** Compatibility day labels: these mean 24 elapsed hours, not UTC buckets. */
export const GUARDRAIL_WINDOW_DAYS = 1;
export const PAUSE_WINDOW_DAYS = 1;
export const GUARDRAIL_WINDOW_MS = DAY_MS;
export const THROTTLED_BROADCAST_RATE_PER_SECOND = 1;

export type DeliverabilityStatus = "ok" | "warning" | "paused";

export interface DeliverabilityReason {
  metric: "bounce" | "complaint";
  rate: number;
  tier: "warning" | "paused";
  /** Window the rate was measured over, so messages can name it truthfully. */
  windowDays: number;
}

/** Counts summed over one window. Hard bounces only: transient ones never count. */
export interface WindowCounts {
  sent: number;
  hardBounced: number;
  complained: number;
}

export interface DeliverabilityEvaluation {
  /** Hard-bounce rate over the warning window. */
  bounceRate: number;
  complaintRate: number;
  status: DeliverabilityStatus;
  reasons: DeliverabilityReason[];
}

export interface DeliverabilityHealth extends DeliverabilityEvaluation {
  /** Sends in the warning window (the denominator of the displayed rates). */
  sent: number;
  windowDays: number;
  pause: WindowCounts & { windowDays: number };
  /** Present on live health; daily counters cannot reconstruct this window. */
  rollingWindow?: {
    start: Date;
    end: Date;
    hours: 24;
    basis: "confirmed_messages_and_distinct_outcomes";
    countingUnit: "message";
    /** Arrival watermark, not occurrence time: catches late callbacks after review release. */
    outcomeWatermark: Date | null;
  };
}

/**
 * Milliseconds to space consecutive broadcast enqueues by, given a team's
 * standing. "ok" fans out at full rate (0 spacing); "warning" and "paused"
 * both drip at THROTTLED_BROADCAST_RATE_PER_SECOND — the fan-out throttles
 * rather than halts (initiation guards block new paused sends upstream).
 */
export function broadcastSendSpacingMs(status: DeliverabilityStatus): number {
  return status === "ok" ? 0 : Math.ceil(1000 / THROTTLED_BROADCAST_RATE_PER_SECOND);
}

const rateOf = (events: number, sent: number): number => (sent > 0 ? events / sent : 0);

/** Pure policy decision. Strict > pauses; warnings use >=. Both use the
 * rolling window supplied by the caller. Zero sends is safe, never NaN.
 */
export function evaluateDeliverability(
  windows: { warn: WindowCounts; pause: WindowCounts },
  minVolume: number = MIN_GUARDRAIL_VOLUME,
): DeliverabilityEvaluation {
  const { warn, pause } = windows;
  const reasons: DeliverabilityReason[] = [];
  const judge = (
    metric: DeliverabilityReason["metric"],
    lines: { warn: number; pause: number; minPauseEvents: number; minWarnEvents: number },
  ) => {
    const events = metric === "bounce" ? "hardBounced" : "complained";
    const pauseRate = rateOf(pause[events], pause.sent);
    if (pause.sent > 0 && pauseRate > lines.pause && pause[events] >= lines.minPauseEvents) {
      reasons.push({ metric, rate: pauseRate, tier: "paused", windowDays: PAUSE_WINDOW_DAYS });
      return;
    }
    const warnRate = rateOf(warn[events], warn.sent);
    if (warn.sent >= minVolume && warnRate >= lines.warn && warn[events] >= lines.minWarnEvents) {
      reasons.push({ metric, rate: warnRate, tier: "warning", windowDays: GUARDRAIL_WINDOW_DAYS });
    }
  };
  judge("bounce", {
    warn: WARN_BOUNCE_RATE,
    pause: PAUSE_BOUNCE_RATE,
    minPauseEvents: MIN_PAUSE_HARD_BOUNCES,
    minWarnEvents: 1,
  });
  judge("complaint", {
    warn: WARN_COMPLAINT_RATE,
    pause: PAUSE_COMPLAINT_RATE,
    minPauseEvents: MIN_PAUSE_COMPLAINTS,
    minWarnEvents: MIN_WARN_COMPLAINTS,
  });

  const status: DeliverabilityStatus = reasons.some((r) => r.tier === "paused")
    ? "paused"
    : reasons.some((r) => r.tier === "warning")
      ? "warning"
      : "ok";

  return {
    bounceRate: rateOf(warn.hardBounced, warn.sent),
    complaintRate: rateOf(warn.complained, warn.sent),
    status,
    reasons,
  };
}

/**
 * Exact event-time window (now - 24h, now], tenant scoped. One accepted
 * message is one denominator unit regardless of To/Cc/Bcc size; each outcome
 * counts at most once per message/metric, even across different SNS IDs.
 * A sentAt claim alone is NOT acceptance: require a provider message ID or
 * a durable provider event. Only Permanent bounces count. Delayed callbacks
 * use occurredAt, never arrival/day buckets; createdAt excludes future reads.
 * Outcomes may refer to older accepted sends. They still count in their own
 * occurrence window; rates are intentionally not clamped to hide that risk.
 */
export async function fetchDeliverabilityHealth(
  db: Db,
  teamId: string,
  opts?: { now?: Date },
): Promise<DeliverabilityHealth> {
  const now = opts?.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid evaluation time");
  const start = new Date(now.getTime() - GUARDRAIL_WINDOW_MS);
  const e = schema.emails;
  const v = schema.emailEvents;
  const row = firstRow<{
    sent: string;
    hardBounced: string;
    complained: string;
    watermark: string | Date | null;
  }>(
    await db.execute(sql`
    -- Bound acceptance probes to the window, not the tenant's lifetime history.
    -- Keep all durable-event types here: a recent sent event can override an
    -- old claim, and an outcome can belong to a much older accepted message.
    -- LATERAL/LIMIT fences keep tenant lookups keyed by ID; one correlated
    -- evidence aggregate avoids OR/EXISTS becoming a lifetime event hash scan.
    with window_events as materialized (
      select ${v.emailId} as email_id, ${v.type} as type,
        ${v.bounceType} as bounce_type, ${v.createdAt} as created_at
      from ${v} inner join lateral (
        select ${e.id} from ${e}
        where ${e.id} = ${v.emailId} and ${e.teamId} = ${teamId}
          and ${e.createdAt} <= ${now}
        limit 1
      ) tenant_email on true
      where ${v.occurredAt} > ${start} and ${v.occurredAt} <= ${now}
        and ${v.createdAt} <= ${now}
        and ${v.type} in ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed')
    ), candidate_ids as materialized (
      select ${e.id} as id from ${e}
      where ${e.teamId} = ${teamId} and ${e.createdAt} <= ${now}
        and ${e.sentAt} > ${start} and ${e.sentAt} <= ${now}
      union
      select email_id as id from window_events
    ), confirmed as materialized (
      select candidate_email.id,
        coalesce(proof.sent_at, candidate_email.sent_at, proof.provider_at) as accepted_at
      from candidate_ids candidates inner join lateral (
        select ${e.id} as id, ${e.sentAt} as sent_at, ${e.sesMessageId} as ses_message_id
        from ${e}
        where ${e.id} = candidates.id and ${e.teamId} = ${teamId}
          and ${e.createdAt} <= ${now}
        limit 1
      ) candidate_email on true
      inner join lateral (
        select min(${v.occurredAt}) filter (where ${v.type} = 'sent') as sent_at,
          min(${v.occurredAt}) filter (
            where ${v.type} = 'sent' or ${v.snsMessageId} is not null
          ) as provider_at
        from ${v}
        where ${v.emailId} = candidate_email.id
          and ${v.type} in ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed')
          and ${v.createdAt} <= ${now} and ${v.occurredAt} <= ${now}
      ) proof on true
      where candidate_email.ses_message_id is not null or proof.provider_at is not null
    ), outcomes as (
      select w.email_id,
        bool_or(w.type = 'bounced' and w.bounce_type = 'Permanent') as hard,
        bool_or(w.type = 'complained') as complaint,
        greatest(
          min(w.created_at) filter (where w.type = 'bounced' and w.bounce_type = 'Permanent'),
          min(w.created_at) filter (where w.type = 'complained')
        ) as arrived_at
      from window_events w inner join confirmed c on c.id = w.email_id
      where ((w.type = 'bounced' and w.bounce_type = 'Permanent') or w.type = 'complained')
      group by w.email_id
    )
    select count(*) filter (where c.accepted_at > ${start} and c.accepted_at <= ${now})::text as sent,
      count(*) filter (where o.hard)::text as "hardBounced",
      count(*) filter (where o.complaint)::text as complained,
      max(o.arrived_at) as watermark
    from confirmed c left join outcomes o on o.email_id = c.id
  `),
  );
  const counts: WindowCounts = {
    sent: Number(row?.sent ?? 0),
    hardBounced: Number(row?.hardBounced ?? 0),
    complained: Number(row?.complained ?? 0),
  };
  return {
    ...evaluateDeliverability({ warn: counts, pause: counts }),
    sent: counts.sent,
    windowDays: GUARDRAIL_WINDOW_DAYS,
    pause: { ...counts, windowDays: PAUSE_WINDOW_DAYS },
    rollingWindow: {
      start,
      end: now,
      hours: 24,
      basis: "confirmed_messages_and_distinct_outcomes",
      countingUnit: "message",
      outcomeWatermark: row?.watermark ? new Date(row.watermark) : null,
    },
  };
}
