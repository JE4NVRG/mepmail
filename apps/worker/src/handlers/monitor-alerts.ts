import { operatorAlertsSink } from "@millionsend/config";
import type { AccountMailKind } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, like } from "drizzle-orm";
import { mailOperator, type SystemMailer } from "../system-mail.js";

/** Durable monitor outbox in the existing notification ledger. The producer
 * writes the intent in the safety transaction. Audit delivery and removal
 * commit atomically; email delivery is at-least-once across process death. */
export async function flushMonitorAlerts(
  db: Db,
  deps: { mailer?: SystemMailer | undefined; appBaseUrl?: string | undefined },
  teamId?: string,
): Promise<number> {
  if (operatorAlertsSink() !== "audit" && !deps.mailer) return 0;
  const n = schema.teamNotifications;
  const pending = await db
    .select()
    .from(n)
    .where(and(like(n.kind, "monitor.pending.%"), teamId ? eq(n.teamId, teamId) : undefined))
    .orderBy(n.sentAt, n.teamId, n.kind)
    .limit(50);
  let delivered = 0;
  for (const item of pending) {
    try {
      const sent = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const where = and(
          eq(n.teamId, item.teamId),
          eq(n.kind, item.kind),
          eq(n.periodKey, item.periodKey),
        );
        const [locked] = await t.select().from(n).where(where).for("update", { skipLocked: true });
        if (!locked) return false;
        const deliveredKind = locked.kind.replace("monitor.pending.", "monitor.delivered.");
        const [receipt] = await t
          .select({ teamId: n.teamId })
          .from(n)
          .where(
            and(
              eq(n.teamId, locked.teamId),
              eq(n.kind, deliveredKind),
              eq(n.periodKey, locked.periodKey),
            ),
          );
        if (receipt) {
          await t.delete(n).where(where);
          return false;
        }

        const intent = JSON.parse(locked.periodKey) as {
          path: string;
          values: Record<string, string>;
        };
        const ok = await mailOperator(
          t,
          deps.mailer,
          locked.kind.slice("monitor.pending.".length).split(":")[0] as AccountMailKind,
          intent.path,
          intent.values,
          deps.appBaseUrl,
          { teamId: locked.teamId, strictAudit: true },
        );
        if (!ok) {
          await t.update(n).set({ sentAt: new Date() }).where(where);
          return false;
        }
        await t
          .insert(n)
          .values({
            teamId: locked.teamId,
            kind: deliveredKind,
            periodKey: locked.periodKey,
            sentAt: locked.sentAt,
          })
          .onConflictDoNothing();
        await t.delete(n).where(where);
        return true;
      });
      if (sent) delivered++;
    } catch {
      // No private payload/provider error in logs. Intent survives rollback.
      await db
        .update(n)
        .set({ sentAt: new Date() })
        .where(
          and(eq(n.teamId, item.teamId), eq(n.kind, item.kind), eq(n.periodKey, item.periodKey)),
        );
      console.error("monitor.alert: delivery failed; durable intent retained", {
        teamId: item.teamId,
      });
    }
  }
  return delivered;
}
