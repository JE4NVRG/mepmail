import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

/**
 * The one action the operator-alert relay reads. Every internal operator
 * alert written with OPERATOR_ALERTS_SINK=audit lands here, with the same
 * subject, body and link its e-mail would have carried, so a relay can post
 * it to Telegram unchanged and a single query covers every alert kind.
 */
export const OPERATOR_ALERT_ACTION = "operator.alert";

/** Plain-text ceiling for one alert body: the trail is a log, not a mailbox. */
export const OPERATOR_ALERT_TEXT_MAX = 1500;

export interface OperatorAlert {
  /** The mail kind the alert would have gone out as, e.g. "review.held". */
  kind: string;
  subject: string;
  /** Plain text, as the mail body would read; HTML never enters the row. */
  text: string;
  /** The link the mail's button carried; empty for an alert that carries none. */
  url?: string | null;
  /** The team the alert is about, or null when it is about the instance. */
  teamId?: string | null;
  target?: { type: string; id: string } | undefined;
  /** The period an alert fires at most once per, when it has one (a daily digest). */
  periodKey?: string | undefined;
}

/** The body as it lands in the row: plain, without surrounding blank lines, clipped at the ceiling. */
export function operatorAlertText(text: string): string {
  const plain = text.trim();
  return plain.length > OPERATOR_ALERT_TEXT_MAX
    ? `${plain.slice(0, OPERATOR_ALERT_TEXT_MAX - 1)}…`
    : plain;
}

/**
 * Strict alert write: callers must retain/retry their intent on failure.
 * Unlike the informational audit trail, this row is the delivery itself.
 */
export async function recordOperatorAlert(db: Db, alert: OperatorAlert): Promise<void> {
  await db.insert(schema.auditLog).values({
    teamId: alert.teamId ?? null,
    actorId: "system",
    action: OPERATOR_ALERT_ACTION,
    target: alert.target ? `${alert.target.type}:${alert.target.id}` : null,
    data: {
      kind: alert.kind,
      subject: alert.subject,
      text: operatorAlertText(alert.text),
      url: alert.url ?? "",
      ...(alert.periodKey ? { periodKey: alert.periodKey } : {}),
    },
  });
}
