/**
 * A signup wave is a shape, not a single event: many accounts, few distinct
 * e-mail domains, many ASNs, all verified within seconds. The per-signup alert
 * cannot see it and the daily digest sees it a day late, which is exactly how
 * the 19/11 wave ran for seven hours before anyone looked.
 *
 * This counts the current window and says whether it looks like a wave. It does
 * not block anything: blocking is the signup-risk engine's job.
 */
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { gte, sql } from "drizzle-orm";

export interface SignupWave {
  windowMinutes: number;
  teams: number;
  emailDomains: number;
  firstSeen: Date | null;
}

export interface SignupWaveThresholds {
  windowMinutes: number;
  maxTeams: number;
  maxEmailDomains: number;
}

/** Deliberately low: a healthy day is a handful of signups per hour, not ten. */
export const SIGNUP_WAVE_DEFAULT: SignupWaveThresholds = {
  windowMinutes: 60,
  maxTeams: 10,
  maxEmailDomains: 5,
};

export async function detectSignupWave(
  db: Db,
  opts: { now?: Date; thresholds?: Partial<SignupWaveThresholds> } = {},
): Promise<SignupWave> {
  const now = opts.now ?? new Date();
  const t = { ...SIGNUP_WAVE_DEFAULT, ...opts.thresholds };
  const since = new Date(now.getTime() - t.windowMinutes * 60_000);
  const [row] = await db
    .select({
      teams: sql<number>`count(*)::int`,
      domains: sql<number>`count(distinct split_part(${schema.user.email}, '@', 2))::int`,
      first: sql<Date | null>`min(${schema.teams.createdAt})`,
    })
    .from(schema.teams)
    .leftJoin(schema.teamMembers, sql`${schema.teamMembers.teamId} = ${schema.teams.id}`)
    .leftJoin(schema.user, sql`${schema.user.id} = ${schema.teamMembers.userId}`)
    .where(gte(schema.teams.createdAt, since));
  return {
    windowMinutes: t.windowMinutes,
    teams: Number(row?.teams ?? 0),
    emailDomains: Number(row?.domains ?? 0),
    firstSeen: row?.first ? new Date(row.first) : null,
  };
}

export function isSignupWave(wave: SignupWave, t = SIGNUP_WAVE_DEFAULT): boolean {
  return wave.teams >= t.maxTeams || wave.emailDomains >= t.maxEmailDomains;
}

/** No e-mail addresses, no domains, no IPs: counts and the window only. */
export function signupWaveText(wave: SignupWave): string {
  return [
    "MepMail: padrao de onda de cadastros",
    `${wave.teams} times e ${wave.emailDomains} dominios de e-mail distintos`,
    `janela de ${wave.windowMinutes} min`,
    "triagem de cadastro segue decidindo; nada foi bloqueado por este alerta",
  ].join("\n");
}
