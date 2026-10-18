import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@millionsend/config";
import {
  createMailboxExternalAccount,
  exchangeMailboxExternalOAuthCode,
  getMailboxExternalAccount,
  MailboxExternalError,
  MailboxExternalOAuthError,
  type MailboxExternalOAuthGrant,
  type MailboxExternalOAuthProvider,
  mailboxExternalOAuthAuth,
  mailboxExternalOAuthAuthorizeUrl,
  mailboxExternalOAuthAvailable,
  mailboxExternalOAuthPkce,
  mailboxExternalOAuthSecret,
  mailboxExternalOAuthServers,
  replaceMailboxExternalSecret,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/api-base-url";
import { recordAudit } from "./audit";
import { getKeyring } from "./keyring";
import { checkMailboxExternalAccount, MailboxExternalCheckError } from "./mailbox-external-connect";
import { mailboxActorAccessEnabled, mailboxRegistryEnabled } from "./mailboxes";
import { mailboxExternalOpen } from "./routers/mailbox-external";
import { createContext } from "./trpc";

/**
 * "Entrar com a Microsoft" / "Entrar com o Google" for contas externas: the start route
 * sends the browser to the provider with PKCE and a state tied to an HttpOnly cookie (the
 * person, the team, the verifier; ten minutes, signed); the callback checks that cookie,
 * trades the code for tokens, proves IMAP and SMTP with the access token and connects the
 * account (or, for "Entrar de novo", replaces the refresh token of the same address). The
 * browser always lands back in the Correio with `?external=connected|reconnected|error`.
 */

export const MAILBOX_EXTERNAL_OAUTH_COOKIE = "mm_ext_oauth";
const COOKIE_PATH = "/api/mailboxes/external/oauth";
const TTL_MS = 10 * 60_000;
/** Where the browser may come back to (the Correio, or onboarding's first step). */
const RETURN_PATHS = new Set(["/mail", "/onboarding"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MailboxExternalOAuthOutcome =
  | "cancelled"
  | "expired"
  | "forbidden"
  | "unavailable"
  | "provider_unavailable"
  | "oauth_failed"
  | "oauth_incomplete"
  | "other_account"
  | "conflict"
  | "limit"
  | "imap_login"
  | "imap_network"
  | "smtp_login"
  | "smtp_network"
  | "invalid_server";

interface Pending {
  /** provider */
  p: MailboxExternalOAuthProvider;
  /** state sent to the provider */
  s: string;
  /** PKCE verifier */
  v: string;
  /** team and person who started */
  t: string;
  u: string;
  /** the account being signed in again, if any */
  m: string | null;
  /** where to come back to */
  r: string;
  /** expiry (ms) */
  e: number;
}

let cachedKey: { source: string; key: Buffer } | null = null;
function signingKey(): Buffer | null {
  const master = env.MASTER_ENCRYPTION_KEY;
  if (!master) return null;
  if (cachedKey?.source !== master)
    cachedKey = {
      source: master,
      key: createHmac("sha256", Buffer.from(master, "base64"))
        .update("mepmail/external-oauth/v1")
        .digest(),
    };
  return cachedKey.key;
}

function seal(pending: Pending): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

function unseal(value: string | undefined, now = Date.now()): Pending | null {
  const key = signingKey();
  if (!key || !value || value.length > 2048) return null;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(createHmac("sha256", key).update(payload).digest("base64url"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const pending = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Pending;
    if (typeof pending.e !== "number" || pending.e <= now) return null;
    if (pending.p !== "google" && pending.p !== "microsoft") return null;
    return pending;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function mailboxExternalOAuthRedirectUri(provider: MailboxExternalOAuthProvider) {
  return `${appBaseUrl()}/api/mailboxes/external/oauth/${provider}/callback`;
}

function returnPath(value: string | null | undefined) {
  return value && RETURN_PATHS.has(value) ? value : "/mail";
}

function back(path: string, params: Record<string, string>) {
  const url = new URL(path, appBaseUrl());
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function withCookie(response: NextResponse, value: string | null) {
  response.cookies.set(MAILBOX_EXTERNAL_OAUTH_COOKIE, value ?? "", {
    httpOnly: true,
    secure: appBaseUrl().startsWith("https:"),
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge: value ? TTL_MS / 1000 : 0,
  });
  return response;
}

function isProvider(value: string): value is MailboxExternalOAuthProvider {
  return value === "google" || value === "microsoft";
}

/** Who may connect here: signed in, a member of the active team, Correio and pilot open. */
async function connectingActor(request: Request) {
  if (!mailboxRegistryEnabled()) return { error: "unavailable" as const };
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.session) return { error: "forbidden" as const };
  if (!ctx.teamId || !ctx.role || ctx.supportView) return { error: "forbidden" as const };
  const actor = { teamId: ctx.teamId, userId: ctx.session.user.id };
  // These REST routes do not pass through protectedProcedure. Check the live
  // membership before any provider redirect, code exchange or connection probe;
  // even an unrecognized operational profile must not become a normal member.
  const [member] = await ctx.db
    .select({ operationsAccess: schema.teamMembers.operationsAccess })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  if (!member || member.operationsAccess !== null) return { error: "forbidden" as const };
  if (!mailboxExternalOpen(ctx.teamId) || !(await mailboxActorAccessEnabled(ctx.db, actor)))
    return { error: "unavailable" as const };
  return { ctx: { ...ctx, teamId: ctx.teamId, session: ctx.session }, actor };
}

/**
 * GET /api/mailboxes/external/oauth/{provider}/start[?mailbox=<id>][&hint=<email>][&return=/mail]
 * — to the provider's consent page. `mailbox` signs an existing account in again.
 */
export async function startMailboxExternalOAuth(request: Request, provider: string) {
  const url = new URL(request.url);
  const returnTo = returnPath(url.searchParams.get("return"));
  const fail = (reason: MailboxExternalOAuthOutcome) =>
    back(returnTo, { external: "error", reason, provider });
  if (!isProvider(provider)) return fail("provider_unavailable");
  const who = await connectingActor(request);
  if ("error" in who) return fail(who.error ?? "forbidden");
  if (!mailboxExternalOAuthAvailable()[provider]) return fail("provider_unavailable");
  const mailbox = url.searchParams.get("mailbox");
  if (mailbox && !UUID.test(mailbox)) return fail("expired");
  const hint = url.searchParams.get("hint")?.trim().toLowerCase();
  const pkce = mailboxExternalOAuthPkce();
  const state = randomBytes(24).toString("base64url");
  const sealed = seal({
    p: provider,
    s: state,
    v: pkce.verifier,
    t: who.actor.teamId,
    u: who.actor.userId,
    m: mailbox,
    r: returnTo,
    e: Date.now() + TTL_MS,
  });
  if (!sealed) return fail("unavailable");
  const location = mailboxExternalOAuthAuthorizeUrl(provider, {
    redirectUri: mailboxExternalOAuthRedirectUri(provider),
    state,
    codeChallenge: pkce.challenge,
    ...(hint && EMAIL.test(hint) && hint.length <= 254 ? { loginHint: hint } : {}),
  });
  const response = NextResponse.redirect(location, 303);
  response.headers.set("Cache-Control", "no-store");
  return withCookie(response, sealed);
}

/** GET /api/mailboxes/external/oauth/{provider}/callback?code&state — connect, then back. */
export async function finishMailboxExternalOAuth(
  request: Request,
  provider: string,
  cookie: string | undefined,
  deps: {
    exchange?: typeof exchangeMailboxExternalOAuthCode;
    check?: typeof checkMailboxExternalAccount;
  } = {},
) {
  const pending = unseal(cookie);
  const returnTo = returnPath(pending?.r);
  const done = (params: Record<string, string>) => withCookie(back(returnTo, params), null);
  const fail = (reason: MailboxExternalOAuthOutcome) =>
    done({ external: "error", reason, provider });
  if (!isProvider(provider) || !pending || pending.p !== provider) return fail("expired");
  const url = new URL(request.url);
  // The person said no (or closed the provider's page): nothing to explain.
  if (url.searchParams.get("error")) return fail("cancelled");
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!state || !code || code.length > 4096 || !safeEqual(state, pending.s)) return fail("expired");
  const who = await connectingActor(request);
  if ("error" in who) return fail(who.error ?? "forbidden");
  if (who.actor.userId !== pending.u || who.actor.teamId !== pending.t) return fail("forbidden");

  let grant: MailboxExternalOAuthGrant;
  try {
    grant = await (deps.exchange ?? exchangeMailboxExternalOAuthCode)(provider, {
      code,
      codeVerifier: pending.v,
      redirectUri: mailboxExternalOAuthRedirectUri(provider),
    });
  } catch (error) {
    if (error instanceof MailboxExternalOAuthError) {
      console.warn(`mailbox.external oauth ${provider}: ${error.message}`);
      return fail(error.reason === "incomplete" ? "oauth_incomplete" : "oauth_failed");
    }
    throw error;
  }
  const servers = mailboxExternalOAuthServers(provider, grant);
  try {
    await (deps.check ?? checkMailboxExternalAccount)(servers, { accessToken: grant.accessToken });
  } catch (error) {
    if (error instanceof MailboxExternalCheckError) return fail(error.reason);
    throw error;
  }
  const secret = mailboxExternalOAuthSecret(grant.refreshToken);
  const { ctx, actor } = who;
  try {
    if (pending.m) {
      const account = await getMailboxExternalAccount(ctx.db, actor, pending.m);
      if (
        account.auth !== mailboxExternalOAuthAuth(provider) ||
        account.username.toLowerCase() !== grant.address
      )
        return fail("other_account");
      await replaceMailboxExternalSecret(ctx.db, getKeyring(), actor, {
        mailboxId: pending.m,
        secret,
      });
      await recordAudit(ctx, {
        action: "mailbox.external_password_replaced",
        target: { type: "mailbox", id: pending.m },
        metadata: { provider: servers.provider, auth: mailboxExternalOAuthAuth(provider) },
      });
      return done({ external: "reconnected", mailbox: pending.m });
    }
    const created = await createMailboxExternalAccount(ctx.db, getKeyring(), actor, {
      address: grant.address,
      label: (grant.name ?? grant.address).slice(0, 80),
      servers,
      secret,
      auth: mailboxExternalOAuthAuth(provider),
    });
    await recordAudit(ctx, {
      action: "mailbox.external_connected",
      target: { type: "mailbox", id: created.mailboxId },
      metadata: { provider: servers.provider, auth: mailboxExternalOAuthAuth(provider) },
    });
    return done({ external: "connected", mailbox: created.mailboxId });
  } catch (error) {
    if (error instanceof MailboxExternalError)
      return fail(
        error.code === "conflict"
          ? "conflict"
          : error.code === "limit"
            ? "limit"
            : error.code === "not_found"
              ? "expired"
              : "forbidden",
      );
    throw error;
  }
}
