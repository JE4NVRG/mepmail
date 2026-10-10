import { createHmac, randomUUID } from "node:crypto";
import { mailboxServiceActive } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { count, eq, sql } from "drizzle-orm";
import { eloziSupportChannel } from "@/lib/elozi-support";
import { getActiveMembership } from "./membership";

/**
 * Verified identity for the Elozi support chat (contract 0.51.16): the chat
 * knows who is writing, so Jean answers the right account. The token is signed
 * here and only here; the secret never reaches the browser.
 *
 * Env: ELOZI_IDENTITY_SECRET (the channel secret Elozi shows once, used as its
 * literal UTF-8 string) and ELOZI_IDENTITY_KID (the key id shown with it).
 */
export const ELOZI_IDENTITY_ISSUER = "https://mepmail.dev";
const TTL_SECONDS = 600;

export interface EloziIdentityKey {
  secret: string;
  kid: string;
}

export function eloziIdentityKey(
  env: Record<string, string | undefined> = process.env,
): EloziIdentityKey | null {
  const secret = env.ELOZI_IDENTITY_SECRET ?? "";
  const kid = env.ELOZI_IDENTITY_KID ?? "";
  return secret.length >= 32 && /^[A-Za-z0-9_.-]{1,120}$/.test(kid) ? { secret, kid } : null;
}

export interface EloziIdentityClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  locale: "pt-BR" | "en";
  ctx: { teamId: string; teamName: string; plan: string; mailboxes: number };
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** HS256 JWT with the `kid` header; exp is iat + 10 min, jti unique per token. */
export function signEloziIdentity(
  claims: EloziIdentityClaims,
  key: EloziIdentityKey,
  channelId: string = eloziSupportChannel.channelId,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: key.kid }));
  const payload = base64url(
    JSON.stringify({
      iss: ELOZI_IDENTITY_ISSUER,
      aud: `elozi:webchat:${channelId}`,
      ...claims,
      iat,
      exp: iat + TTL_SECONDS,
      jti: randomUUID(),
    }),
  );
  const signature = createHmac("sha256", Buffer.from(key.secret, "utf8"))
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

/**
 * The claims for a signed-in user on their active team: name, email and the
 * team context the support desk needs (plan and how many mailboxes). Nothing
 * about billing amounts, keys or mail content.
 */
export async function supportIdentityClaims(
  db: Db,
  user: { id: string; email: string; name: string; emailVerified: boolean },
  locale: string,
  preferredTeamId?: string,
): Promise<EloziIdentityClaims | null> {
  const membership = await getActiveMembership(db, user.id, preferredTeamId);
  if (!membership) return null;
  let mailboxes = 0;
  let correio = false;
  const [extension] = await db
    .select({ installed: sql<boolean>`to_regclass('public.mailboxes') is not null` })
    .from(sql`(select 1) as mailbox_extension`);
  if (extension?.installed) {
    const [boxes] = await db
      .select({ n: count() })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.teamId, membership.teamId));
    mailboxes = boxes?.n ?? 0;
    const [plan] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, membership.teamId));
    correio = mailboxServiceActive(plan);
  }
  return {
    sub: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    name: clip(user.name || user.email.split("@")[0] || "", 120),
    locale: locale === "en" ? "en" : "pt-BR",
    ctx: {
      teamId: membership.teamId,
      teamName: clip(membership.teamName, 120),
      plan: `${membership.plan}${correio ? "+correio" : ""}`,
      mailboxes,
    },
  };
}
