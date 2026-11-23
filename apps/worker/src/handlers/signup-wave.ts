import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, gte } from "drizzle-orm";
import { notifyRegionBreaker as notifyOperator } from "../../../../packages/core/src/region-breaker-notice.js";
import {
  detectSignupWave,
  isSignupWave,
  SIGNUP_WAVE_DEFAULT,
  type SignupWave,
  signupWaveText,
} from "../../../../packages/core/src/signup-wave.js";

export interface SignupWaveAlertDeps {
  now?: Date;
  /** Injected in tests; defaults to the operator's Telegram. */
  notify?: (text: string) => void;
}

/**
 * Alert once per window when the signup shape looks like a wave. The audit row
 * is the dedupe: a second run inside the same window sees its own alert and
 * stays quiet, so the operator gets one message per wave instead of one per
 * fifteen minutes.
 */
export async function alertSignupWave(
  db: Db,
  deps: SignupWaveAlertDeps = {},
): Promise<{ alerted: boolean; wave: SignupWave }> {
  const now = deps.now ?? new Date();
  const wave = await detectSignupWave(db, { now });
  if (!isSignupWave(wave)) return { alerted: false, wave };
  const since = new Date(now.getTime() - SIGNUP_WAVE_DEFAULT.windowMinutes * 60_000);
  const [recent] = await db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.action, "signup.wave_alert"), gte(schema.auditLog.createdAt, since)),
    )
    .limit(1);
  if (recent) return { alerted: false, wave };
  await db.insert(schema.auditLog).values({
    teamId: null,
    actorId: "signup.wave_alert",
    action: "signup.wave_alert",
    target: "signup",
    data: {
      teams: wave.teams,
      emailDomains: wave.emailDomains,
      windowMinutes: wave.windowMinutes,
    },
  });
  (deps.notify ?? notifyOperator)(signupWaveText(wave));
  return { alerted: true, wave };
}
