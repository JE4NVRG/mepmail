import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { sql } from "drizzle-orm";

import { OPERATOR_ALERT_ACTION, operatorAlertText } from "./operator-alerts.js";

export const MAILBOX_SEND_HOLD_ALERT_AFTER_MS = 15 * 60 * 1000;
export const MAILBOX_SEND_HOLD_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const REASONS = [
  "review_required",
  "campaign_consent_required",
  "campaign_sending_disabled",
  "sending_paused",
  "provider_unavailable",
  "quota_exceeded",
  "rate_limited",
  "domain_not_ready",
  "recipient_check_unavailable",
  "configuration_unavailable",
  "content_review",
  "preflight_unavailable",
] as const;
export interface MailboxSendHoldSnapshot {
  count: number;
  oldestAt: Date;
}
export interface MailboxSendHoldAlertState {
  kind: "mailbox.send_hold.retained" | "mailbox.send_hold.recovered";
  createdAt: Date;
}

/** One instance-wide aggregate per safe reason. No message or recipient content. */
export function mailboxSendHoldAlertDecision(
  snapshot: MailboxSendHoldSnapshot | null,
  previous: MailboxSendHoldAlertState | null,
  now: Date,
  unresolvedAttempt = false,
): "retained" | "recovered" | null {
  const retained =
    snapshot !== null &&
    snapshot.count > 0 &&
    now.getTime() - snapshot.oldestAt.getTime() >= MAILBOX_SEND_HOLD_ALERT_AFTER_MS;
  // A claim temporarily clears its hold metadata. Missing queued rows are not
  // recovery evidence while an old attempt is in flight or remains ambiguous.
  if (!retained)
    return !unresolvedAttempt && previous?.kind === "mailbox.send_hold.retained"
      ? "recovered"
      : null;
  if (
    previous?.kind === "mailbox.send_hold.retained" &&
    now.getTime() - previous.createdAt.getTime() < MAILBOX_SEND_HOLD_ALERT_COOLDOWN_MS
  ) {
    return null;
  }
  return "retained";
}

/**
 * Call from the existing outbox reconcile cadence. Audit rows ARE the durable
 * state: no process-local cache, scheduler, schema or secondary delivery write.
 * The relay consumes the same operator.alert row that commits the dedupe state.
 * Try-lock serializes concurrent reconcilers; transaction rollback keeps failed
 * writes retryable. Only the exact allowlisted mailbox_deferred codes qualify.
 * At most 12 aggregates, 12 ledger rows and 3 sample IDs per emitted alert leave
 * PostgreSQL. Counts cover all queued retained rows, not a truncated page.
 */
export async function alertRetainedMailboxSends(db: Db, now = new Date()) {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      await tx.execute(sql`set local lock_timeout = '100ms'`);
      const [lock] = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(18475923, 12) as acquired`,
      );
      if (!lock?.acquired) return { alerted: 0, recovered: 0, skipped: true, failed: false };
      const codes = REASONS.map((reason) => sql`${`mailbox_deferred:${reason}`}`);
      const groups = await tx.execute<{ code: string; count: string; oldest: string }>(sql`
        select error_code as code, count(*)::text as count, min(created_at)::text as oldest
        from mailbox_outbox
        where status = 'queued' and error_code in (${sql.join(codes, sql`, `)})
        group by error_code limit 12
      `);
      const [attempt] = await tx.execute<{ pending: boolean }>(sql`
        select exists (
          select 1 from mailbox_outbox where status in ('sending', 'unknown')
            and created_at <= ${new Date(now.getTime() - MAILBOX_SEND_HOLD_ALERT_AFTER_MS).toISOString()}::timestamptz
        ) as pending
      `);
      let alerted = 0;
      let recovered = 0;
      for (const reason of REASONS) {
        const target = `mailbox_send_hold:${reason}`;
        const [last] = await tx.execute<{ kind: string; created: string }>(sql`
          select data->>'kind' as kind, created_at::text as created from audit_log
          where action = ${OPERATOR_ALERT_ACTION} and target = ${target}
            and data->>'kind' in ('mailbox.send_hold.retained', 'mailbox.send_hold.recovered')
          order by created_at desc, id desc limit 1
        `);
        const previous: MailboxSendHoldAlertState | null = last
          ? {
              kind: last.kind as MailboxSendHoldAlertState["kind"],
              createdAt: new Date(last.created),
            }
          : null;
        const code = `mailbox_deferred:${reason}`;
        const group = groups.find((row) => row.code === code);
        const snapshot = group
          ? { count: Number(group.count), oldestAt: new Date(group.oldest) }
          : null;
        const decision = mailboxSendHoldAlertDecision(
          snapshot,
          previous,
          now,
          Boolean(attempt?.pending),
        );
        if (!decision) continue;
        const sample =
          decision === "retained"
            ? await tx.execute<{ id: string }>(sql`
                select id from mailbox_outbox where status = 'queued' and error_code = ${code}
                order by created_at, id limit 3
              `)
            : [];
        const count = snapshot?.count ?? 0;
        const oldestAgeMinutes = snapshot
          ? Math.max(0, Math.floor((now.getTime() - snapshot.oldestAt.getTime()) / 60000))
          : 0;
        // Strict insert, unlike best-effort recordAudit: never swallow a failed
        // ledger write inside the transaction that owns deduplication.
        await tx.insert(schema.auditLog).values({
          teamId: null,
          actorId: "system",
          action: OPERATOR_ALERT_ACTION,
          target,
          // Keep ledger order unambiguous even when cadences share a clock tick.
          createdAt: new Date(Math.max(now.getTime(), (previous?.createdAt.getTime() ?? 0) + 1)),
          data: {
            kind: `mailbox.send_hold.${decision}`,
            subject: `Native queued sends ${decision}: ${reason}`,
            text: operatorAlertText(
              `reason=${reason}; queued_count=${count}; oldest_age_minutes=${oldestAgeMinutes}; sample_outbox_ids=${sample.map((row) => row.id).join(",") || "none"}`,
            ),
            url: "",
            reason,
            count,
            oldestAgeMinutes,
            sampleOutboxIds: sample.map((row) => row.id),
          },
        });
        if (decision === "retained") alerted++;
        else recovered++;
      }
      return { alerted, recovered, skipped: false, failed: false };
    });
  } catch {
    // Alert infrastructure must not prevent recovery/enqueue of the real outbox.
    return { alerted: 0, recovered: 0, skipped: false, failed: true };
  }
}
