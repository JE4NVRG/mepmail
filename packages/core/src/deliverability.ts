import type { Db } from "@millionsend/db";
// Schema via the clean subpath, never the package barrel: the barrel pulls the
// postgres driver (node:net), which breaks any client bundle that imports this
// module's thresholds. The type-only Db import above is erased.
import * as schema from "@millionsend/db/schema";
import { sql } from "drizzle-orm";
import { firstRow } from "./driver-result.js";
import { reputationCircuitTriggered } from "./graduated-sending-policy.js";
import { DAY_MS } from "./utc-day.js";

/** Internal MepMail anti-abuse policy, NOT provider limits or guarantees.
 * Warning and pause both use an exact rolling 24-hour window (start, end].
 * Pause is strictly above the line; equality warns but does not pause.
 * Strict tenant circuit thresholds have no sample floor. One confirmed
 * outcome can cross the line; equality never pauses. Unknown denominators
 * are not positive clean-sending evidence.
 */
export const WARN_BOUNCE_RATE = 0.015;
export const WARN_COMPLAINT_RATE = 0.0005;
export const PAUSE_BOUNCE_RATE = 0.02;
export const PAUSE_COMPLAINT_RATE = 0.001;
/** Any confirmed complaint pauses the tenant, whatever the denominator. */
export const PAUSE_ON_ANY_COMPLAINT = true;
/** Warning-only anti-noise floor. It must not exempt trial senders from pauses. */
export const MIN_GUARDRAIL_VOLUME = 100;
export const MIN_PAUSE_COMPLAINTS = 1;
export const MIN_PAUSE_HARD_BOUNCES = 1;
/** Denominator floor for a bounce pause. Below this the window is too small to
 * call a rate; the graduated projection treats unknown rates as unknown. */
export const MIN_PAUSE_SENDS = 1;
/** Complaints keep no volume floor: one is enough, whatever the volume. */
export const MIN_PAUSE_COMPLAINT_SENDS = 1;
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
    lines: {
      warn: number;
      pause: number;
      minPauseEvents: number;
      minPauseSends: number;
      minWarnEvents: number;
    },
  ) => {
    const events = metric === "bounce" ? "hardBounced" : "complained";
    const pauseRate = rateOf(pause[events], pause.sent);
    // A confirmed complaint pauses on its own: there is no rate that makes a
    // complaint acceptable while the account is one strike from losing SES.
    const anyComplaint = metric === "complaint" && PAUSE_ON_ANY_COMPLAINT;
    const pauseLineTripped = anyComplaint
      ? pause[events] >= MIN_PAUSE_COMPLAINTS
      : pause.sent >= lines.minPauseSends &&
        pauseRate > lines.pause &&
        pause[events] >= lines.minPauseEvents;
    if (pauseLineTripped) {
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
    minPauseSends: MIN_PAUSE_SENDS,
    minWarnEvents: 1,
  });
  judge("complaint", {
    warn: WARN_COMPLAINT_RATE,
    // Any confirmed complaint pauses, so the pause line is zero rather than 0.1%.
    pause: PAUSE_ON_ANY_COMPLAINT ? 0 : PAUSE_COMPLAINT_RATE,
    minPauseEvents: MIN_PAUSE_COMPLAINTS,
    minPauseSends: MIN_PAUSE_COMPLAINT_SENDS,
    minWarnEvents: MIN_WARN_COMPLAINTS,
  });

  // Adverse outcomes without a denominator still hold; do not fabricate a rate/reason percentage.
  const status: DeliverabilityStatus =
    reputationCircuitTriggered(pause) || reasons.some((r) => r.tier === "paused")
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
 *
 * One Permanent bounce is excluded from the hard numerator and the adversity
 * watermark: SES `OnAccountSuppressionList` with authenticated SNS provenance
 * and that exact subtype, i.e. the address sat on the instance-wide ACCOUNT
 * suppression list and SES never attempted a delivery for this team (see
 * process-provider-event isAccountListDrop). The event row, status and webhook
 * stay recorded, the acceptance still counts in the denominator, and everything
 * else — the tenant's own list, General, a real Permanent, complaints, a null
 * or malformed payload, or a non-SES `azure:` sender id — keeps counting.
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
        ${v.bounceType} as bounce_type, ${v.createdAt} as created_at,
        -- Account-level suppression drop: SES never attempted this delivery.
        -- Require authenticated SES provenance (an SNS message id that is not
        -- the Azure sender) plus the exact subtype inside an object payload,
        -- so a purged/null/malformed payload never becomes an exemption.
        coalesce((${v.type} = 'bounced' and ${v.bounceType} = 'Permanent'
          and ${v.snsMessageId} is not null and ${v.snsMessageId} not like 'azure:%'
          and jsonb_typeof(${v.data} -> 'bounce') = 'object'
          and ${v.data} -> 'bounce' ->> 'bounceSubType' = 'OnAccountSuppressionList'
        ), false) as account_suppression_drop
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
      -- Account mail (verification, reset, invitations) is the platform's own
      -- transactional traffic: its bounces must never become a tenant's
      -- reputation evidence, or one mistyped signup address suspends the owner.
      select ${e.id} as id from ${e}
      where ${e.teamId} = ${teamId} and ${e.createdAt} <= ${now}
        and ${e.sentAt} > ${start} and ${e.sentAt} <= ${now}
        and (${e.tags} is null or not (${e.tags} ? 'mepmail_system'))
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
          and (${e.tags} is null or not (${e.tags} ? 'mepmail_system'))
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
        and not w.account_suppression_drop
      group by w.email_id
    )
    select count(*) filter (where c.accepted_at > ${start} and c.accepted_at <= ${now})::text as sent,
      count(*) filter (where o.hard)::text as "hardBounced",
      count(*) filter (where o.complaint)::text as complained,
      max(o.arrived_at) as watermark
    from confirmed c left join outcomes o on o.email_id = c.id
  `),
  );
  const nativeReady = await nativeReputationSchemaReady(db);
  const native = nativeReady
    ? firstRow<{
        sent: string;
        hard: string;
        complaint: string;
        watermark: Date | null;
      }>(
        await db.execute(sql`
    with facts as (${nativeReputationRows(teamId, now, start)})
    select count(*) filter(where accepted_at > ${start} and accepted_at <= ${now})::text as sent,
      count(*) filter(where hard)::text as hard,count(*) filter(where complaint)::text as complaint,
      max(watermark) as watermark from facts
  `),
      )
    : undefined;
  if (nativeReady && !native) throw new Error("native_reputation_read_unknown");
  const counts: WindowCounts = {
    sent: Number(row?.sent ?? 0) + Number(native?.sent ?? 0),
    hardBounced: Number(row?.hardBounced ?? 0) + Number(native?.hard ?? 0),
    complained: Number(row?.complained ?? 0) + Number(native?.complaint ?? 0),
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
      outcomeWatermark:
        [row?.watermark, native?.watermark]
          .filter((v): v is string | Date => !!v)
          .map((v) => new Date(v))
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    },
  };
}

/** An absent optional installation is different from a failed or partial one.
 * Resolve the same search_path as the queries below. Never catch catalog/read
 * errors or cache this across migrations/transactions: unknown must fail closed.
 */
export async function nativeReputationSchemaReady(db: Db): Promise<boolean> {
  const row = firstRow<{
    boxes: string | null;
    outbox: string | null;
    events: string | null;
    outcomes: string | null;
  }>(
    await db.execute(sql`select to_regclass('mailboxes')::text as boxes,
    to_regclass('mailbox_outbox')::text as outbox,
    to_regclass('mailbox_outbound_events')::text as events,
    to_regclass('mailbox_outbound_outcomes')::text as outcomes`),
  );
  if (!row) throw new Error("native_reputation_schema_unknown");
  const relations = [row.boxes, row.outbox, row.events, row.outcomes];
  if (relations.every((value) => typeof value === "string" && value.length > 0)) return true;
  if (!relations.every((value) => value === null))
    throw new Error("native_reputation_schema_partial");

  // Same opt-ins as worker/server.ts and migrate-mailboxes.ts. Disabling an
  // opt-in is NOT evidence that historical Native participation disappeared.
  if (
    ["1", "true"].includes(process.env.MAILBOX_REGISTRY_ENABLED ?? "") ||
    process.env.MAILBOX_TRANSPORT_ENABLED === "1"
  ) {
    throw new Error("native_reputation_schema_required");
  }
  const footprint = firstRow<{
    migrated: boolean;
    remainingPrivate: boolean;
    mainJudge: string | null;
    audit: string | null;
  }>(
    await db.execute(sql`select
    exists(select 1 from pg_catalog.pg_class c
      where c.relname='__mailbox_migrations' and c.relkind in ('r','p')) as migrated,
    exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname=any(current_schemas(false))
        and c.relkind in ('r','p','v','m','f') and left(c.relname,8)='mailbox_') as "remainingPrivate",
    to_regclass('sending_judge_attempts')::text as "mainJudge",
    to_regclass('audit_log')::text as audit`),
  );
  if (
    !footprint ||
    typeof footprint.migrated !== "boolean" ||
    typeof footprint.remainingPrivate !== "boolean" ||
    !(footprint.mainJudge === null || typeof footprint.mainJudge === "string") ||
    typeof footprint.audit !== "string"
  )
    throw new Error("native_reputation_schema_unknown");
  if (footprint.migrated || footprint.remainingPrivate)
    throw new Error("native_reputation_history_unavailable");
  // MAIN identity is immutable and survives deletion of nullable FK pointers.
  // No time window: disabling Native must not age participation out of safety.
  if (footprint.mainJudge !== null) {
    const judge = firstRow<{ seen: boolean }>(
      await db.execute(sql`select exists(
      select 1 from sending_judge_attempts where message_kind='mailbox') as seen`),
    );
    if (!judge || typeof judge.seen !== "boolean")
      throw new Error("native_reputation_schema_unknown");
    if (judge.seen) throw new Error("native_reputation_history_unavailable");
  }
  // Legacy activity was persisted in MAIN audit_log before the judge ledger.
  // The optional private migration tracker and remaining relations above cover
  // the standard install even if no outbound attempt was ever recorded.
  const activity = firstRow<{ seen: boolean }>(
    await db.execute(sql`select exists(
    select 1 from audit_log where action like 'mailbox.%') as seen`),
  );
  if (!activity || typeof activity.seen !== "boolean")
    throw new Error("native_reputation_schema_unknown");
  if (activity.seen) throw new Error("native_reputation_history_unavailable");
  return false;
}

/** Private confirmed-message projection. Never exports MIME, addresses or hashes.
 * Candidate discovery is occurrence-window bounded; every event is then bound
 * to its exact tenant/box/attempt/provider and an approved private outcome.
 * Accepted outbox metadata is the trusted worker acknowledgement, not a claim.
 */
export function nativeReputationRows(teamId: string, now: Date, start: Date, domainId?: string) {
  return sql`
 with candidates as materialized (
   select o.id from mailbox_outbox o where o.team_id=${teamId}::uuid
     and o.accepted_at >= ${start} and o.accepted_at <= ${now}
   union
   select v.outbox_id from mailbox_outbound_events v
     inner join mailbox_outbox o on o.id=v.outbox_id and o.team_id=${teamId}::uuid
     where v.occurred_at >= ${start} and v.occurred_at <= ${now} and v.received_at <= ${now}
 ), facts as (
   select o.id,o.accepted_at,
     coalesce(bool_or(v.outcome='hard_bounce'),false) as hard,
     coalesce(bool_or(v.outcome='complaint'),false) as complaint,
     max(v.received_at) filter(where v.outcome in ('hard_bounce','complaint')) as watermark
   from candidates c inner join mailbox_outbox o on o.id=c.id and o.team_id=${teamId}::uuid
   inner join mailboxes b on b.id=o.mailbox_id and b.team_id=o.team_id and b.origin='domain'
   left join mailbox_outbound_events v on v.outbox_id=o.id and v.attempt_id=o.attempt_id
     and v.provider_message_id=o.provider_message_id
     and v.occurred_at > ${start} and v.occurred_at <= ${now} and v.received_at <= ${now}
     and exists(select 1 from mailbox_outbound_outcomes x where x.event_id=v.id and x.recipient_hash=any(o.recipient_hashes))
   where o.status='accepted' and o.provider_message_id is not null and o.accepted_at <= ${now}
     and o.created_at <= ${now}
     and not exists(select 1 from mailbox_outbound_events rejected where rejected.outbox_id=o.id
       and rejected.attempt_id=o.attempt_id and rejected.provider_message_id=o.provider_message_id
       and rejected.outcome in ('rejected','rendering_failed') and rejected.received_at<=${now}
       and rejected.occurred_at<=${now}) ${domainId ? sql`and b.domain_id=${domainId}::uuid` : sql``}
   group by o.id,o.accepted_at
 ) select * from facts`;
}
