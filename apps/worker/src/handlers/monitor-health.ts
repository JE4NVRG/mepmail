import {
  MONITOR_STALL_STREAK,
  markLostSamples,
  monitorHealth,
  recordProbes,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import type { SystemMailer } from "../system-mail.js";
import { flushMonitorAlerts } from "./monitor-alerts.js";

export interface MonitorHealthDeps {
  /** Null disables new judgments/probes; existing durable recovery still runs. */
  judge: { provider: string; model: string } | null;
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  /** Compatibility observation only; durable ledger owns notification cadence. */
  state: { degradedMailedAt: Date | null };
  now?: Date | undefined;
}

/** Past this unjudged share, on at least this many samples, the operator hears about it. */
export const MONITOR_DEGRADED_RATE = 0.2;
export const MONITOR_DEGRADED_MIN_SAMPLES = 20;
export const MONITOR_DEGRADED_MAIL_INTERVAL_MS = 6 * 3600_000;

/**
 * The last hour's sample count and unjudged share as probes for the console,
 * pending samples whose job never came back marked, and one notice to the
 * operator when the judge keeps failing. Intent, retry and rolling cadence
 * survive worker restart in the existing notification ledger.
 */
export async function runMonitorHealth(
  db: Db,
  deps: MonitorHealthDeps,
): Promise<{
  samples: number;
  unjudged: number;
  lost: number;
  degraded: boolean;
  stalled: boolean;
}> {
  const now = deps.now ?? new Date();
  const lost = await markLostSamples(db, now);
  await flushMonitorAlerts(db, deps);
  if (!deps.judge) return { samples: 0, unjudged: 0, lost, degraded: false, stalled: false };
  const judge = deps.judge;
  const health = await monitorHealth(db, now);
  const hourly =
    health.samples >= MONITOR_DEGRADED_MIN_SAMPLES &&
    (health.unjudgedRate ?? 0) > MONITOR_DEGRADED_RATE;
  // A judge that keeps failing at low volume, or whose key or credits are refused, is
  // just as degraded: the hourly share alone needs 20 samples in an hour to see it.
  const stalled =
    health.unjudgedStreak >= MONITOR_STALL_STREAK ||
    (health.unjudgedStreak > 0 && health.lastErrorClass === "no_credentials");
  const degraded = hourly || stalled;
  await recordProbes(
    db,
    [
      { probe: "monitor_samples_1h", value: health.samples, ok: true },
      { probe: "monitor_unjudged_rate", value: health.unjudgedRate, ok: !degraded },
    ],
    now,
  );
  if (degraded) {
    const [sample] = await db
      .select({ teamId: schema.monitorSamples.teamId })
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.status, "unjudged"))
      .orderBy(desc(schema.monitorSamples.createdAt), desc(schema.monitorSamples.id))
      .limit(1);
    if (sample) {
      const kind = hourly ? "monitor.degraded" : "monitor.stalled";
      const period = new Date(
        Math.floor(now.getTime() / MONITOR_DEGRADED_MAIL_INTERVAL_MS) *
          MONITOR_DEGRADED_MAIL_INTERVAL_MS,
      ).toISOString();
      // One stable cadence key per instance incident kind; payload is snapshot metadata only.
      await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await t.execute(sql`select pg_advisory_xact_lock(hashtext('monitor.health.alert'))`);
        const n = schema.teamNotifications;
        const [sent] = await t
          .select()
          .from(n)
          .where(
            and(
              like(n.kind, "monitor.delivered.monitor.%:%"),
              gte(n.sentAt, new Date(now.getTime() - MONITOR_DEGRADED_MAIL_INTERVAL_MS + 1)),
            ),
          )
          .limit(1);
        const [pending] = await t
          .select()
          .from(n)
          .where(like(n.kind, "monitor.pending.monitor.%:%"))
          .limit(1);
        if (!sent && !pending)
          await t
            .insert(n)
            .values({
              teamId: sample.teamId,
              kind: `monitor.pending.${kind}:${period}`,
              periodKey: JSON.stringify({
                path: "/console",
                values: hourly
                  ? {
                      rate: `${Math.round((health.unjudgedRate ?? 0) * 100)}%`,
                      unjudged: String(health.unjudged),
                      samples: String(health.samples),
                      provider: judge.provider,
                      model: judge.model,
                    }
                  : {
                      count: String(health.unjudgedStreak),
                      error: health.lastErrorClass ?? "upstream",
                      provider: judge.provider,
                      model: judge.model,
                    },
              }),
              sentAt: now,
            })
            .onConflictDoNothing();
      });
      const count = await flushMonitorAlerts(db, deps);
      if (count > 0) deps.state.degradedMailedAt = now;
    }
  }
  return { samples: health.samples, unjudged: health.unjudged, lost, degraded, stalled };
}
