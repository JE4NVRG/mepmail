import { createHash, createSign, randomBytes, randomUUID } from "node:crypto";
import type { MailboxExternalServersInput } from "./mailbox-external-accounts.js";

/**
 * Contas externas, fases 2 e 3 (specs/correio-external-accounts.md): "Entrar com a
 * Microsoft" (Hotmail, Outlook.com, Microsoft 365) and "Entrar com o Google" (Gmail,
 * Workspace) instead of an app password. The person consents at the provider; we keep only
 * the refresh token, sealed like the app password, and trade it for a short access token
 * whenever IMAP or SMTP needs one (XOAUTH2). Outlook.com no longer takes app passwords
 * (Microsoft, 2024-09-16), so this is its only door.
 *
 * Credentials come from the environment (production .env, never from code):
 * - Microsoft: MICROSOFT_OAUTH_CLIENT_ID plus a certificate, MICROSOFT_OAUTH_CERT_THUMBPRINT
 *   (SHA-1, hex) and MICROSOFT_OAUTH_CERT_PRIVATE_KEY_B64 (the PEM key, base64). The app
 *   proves itself with a signed client assertion; there is no client secret.
 * - Google: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET. The Gmail scope is
 *   restricted: until Google verifies the app (with a yearly CASA assessment) only listed
 *   test users can consent and their grants last 7 days, so the button shows only with
 *   MAILBOX_EXTERNAL_GOOGLE_OAUTH=1.
 */

export type MailboxExternalOAuthProvider = "google" | "microsoft";

export type MailboxExternalOAuthFailure =
  /** The provider refused the grant: revoked, expired, password changed. Reconnect. */
  | "invalid_grant"
  /** No credentials configured for this provider. */
  | "unconfigured"
  /** The provider answered without what we need (no refresh token, no address). */
  | "incomplete"
  /** Network or provider failure; worth another try. */
  | "unavailable";

export class MailboxExternalOAuthError extends Error {
  constructor(
    public readonly reason: MailboxExternalOAuthFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  scope: "https://mail.google.com/ openid email",
};
const MICROSOFT = {
  authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  scope:
    "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email",
};
/** The tenant every personal Microsoft account (Outlook.com, Hotmail, Live) signs into. */
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
/** A personal Microsoft mailbox address (Outlook.com, Hotmail, Live, MSN, country domains too). */
export const MICROSOFT_CONSUMER_ADDRESS =
  /@(outlook|hotmail|live|msn)\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/;

function googleConfig() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

let microsoftKey: { source: string; pem: string } | null = null;
function microsoftConfig() {
  const id = process.env.MICROSOFT_OAUTH_CLIENT_ID?.trim();
  const thumbprint = process.env.MICROSOFT_OAUTH_CERT_THUMBPRINT?.replace(
    /[\s:]/g,
    "",
  ).toLowerCase();
  const encoded = process.env.MICROSOFT_OAUTH_CERT_PRIVATE_KEY_B64?.trim();
  if (!id || !thumbprint || !/^[0-9a-f]{40}$/.test(thumbprint) || !encoded) return null;
  if (microsoftKey?.source !== encoded)
    microsoftKey = { source: encoded, pem: Buffer.from(encoded, "base64").toString("utf8") };
  if (!microsoftKey.pem.includes("PRIVATE KEY")) return null;
  return { id, thumbprint, privateKey: microsoftKey.pem };
}

/** Which sign-in buttons the dialog may show. */
export function mailboxExternalOAuthAvailable(): Record<MailboxExternalOAuthProvider, boolean> {
  return {
    microsoft: microsoftConfig() !== null,
    google: googleConfig() !== null && process.env.MAILBOX_EXTERNAL_GOOGLE_OAUTH === "1",
  };
}

function base64url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

/** PKCE for one sign-in: the verifier stays with us, the challenge goes to the provider. */
export function mailboxExternalOAuthPkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** Where the browser goes to consent. */
export function mailboxExternalOAuthAuthorizeUrl(
  provider: MailboxExternalOAuthProvider,
  input: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const google = provider === "google";
  const config = google ? googleConfig() : microsoftConfig();
  if (!config) throw new MailboxExternalOAuthError("unconfigured");
  const url = new URL(google ? GOOGLE.authorize : MICROSOFT.authorize);
  url.searchParams.set("client_id", config.id);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", google ? GOOGLE.scope : MICROSOFT.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (google) {
    // A refresh token comes only with offline access, and again only when consent is shown.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("prompt", "select_account");
  }
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

/** Microsoft: the app proves itself with a JWT signed by its certificate's key. */
function microsoftClientAssertion(config: NonNullable<ReturnType<typeof microsoftConfig>>) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5t: base64url(Buffer.from(config.thumbprint, "hex")),
  };
  const payload = {
    aud: MICROSOFT.token,
    iss: config.id,
    sub: config.id,
    jti: randomUUID(),
    nbf: now - 60,
    iat: now,
    exp: now + 600,
  };
  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signed).sign(config.privateKey);
  return `${signed}.${base64url(signature)}`;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
}

async function tokenRequest(
  provider: MailboxExternalOAuthProvider,
  params: Record<string, string>,
  fetcher: typeof fetch,
): Promise<TokenAnswer> {
  const body = new URLSearchParams(params);
  let endpoint: string;
  if (provider === "google") {
    const config = googleConfig();
    if (!config) throw new MailboxExternalOAuthError("unconfigured");
    endpoint = GOOGLE.token;
    body.set("client_id", config.id);
    body.set("client_secret", config.secret);
  } else {
    const config = microsoftConfig();
    if (!config) throw new MailboxExternalOAuthError("unconfigured");
    endpoint = MICROSOFT.token;
    body.set("client_id", config.id);
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    body.set("client_assertion", microsoftClientAssertion(config));
    body.set("scope", MICROSOFT.scope);
  }
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MailboxExternalOAuthError("unavailable", "network");
  }
  const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
  if (!response.ok) {
    // invalid_grant: revoked, expired or the password changed. Anything else may pass.
    if (answer.error === "invalid_grant")
      throw new MailboxExternalOAuthError("invalid_grant", answer.error);
    throw new MailboxExternalOAuthError(
      response.status >= 500 ? "unavailable" : "incomplete",
      String(answer.error ?? response.status).slice(0, 40),
    );
  }
  if (!answer.access_token) throw new MailboxExternalOAuthError("incomplete", "no_access_token");
  return answer;
}

/** The claims of an ID token we just received from the provider's token endpoint. */
function idClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MailboxExternalOAuthGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  /** The signed-in address (lowercase). */
  address: string;
  /** The person's name at the provider, for the mailbox label. */
  name: string | null;
  /** A personal Microsoft account (Outlook.com, Hotmail), not a work or school one. */
  consumer: boolean;
}

/** The callback: the code (with its PKCE verifier) for tokens and the signed-in address. */
export async function exchangeMailboxExternalOAuthCode(
  provider: MailboxExternalOAuthProvider,
  input: { code: string; codeVerifier: string; redirectUri: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<MailboxExternalOAuthGrant> {
  const answer = await tokenRequest(
    provider,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
    fetcher,
  );
  if (!answer.refresh_token) throw new MailboxExternalOAuthError("incomplete", "no_refresh_token");
  const claims = idClaims(answer.id_token);
  const candidates =
    provider === "google"
      ? [claims.email_verified === false ? undefined : claims.email]
      : [claims.email, claims.preferred_username];
  const valid = candidates
    .filter((value): value is string => typeof value === "string" && EMAIL.test(value.trim()))
    .map((value) => value.trim().toLowerCase());
  const consumer = provider === "microsoft" && claims.tid === MICROSOFT_CONSUMER_TENANT;
  // A personal account can sign in under an alias on another domain; IMAP wants the mailbox.
  const address =
    (consumer ? valid.find((value) => MICROSOFT_CONSUMER_ADDRESS.test(value)) : undefined) ??
    valid[0];
  if (!address) throw new MailboxExternalOAuthError("incomplete", "no_address");
  return {
    accessToken: answer.access_token!,
    refreshToken: answer.refresh_token,
    expiresAt: new Date(now + Math.max(60, Number(answer.expires_in ?? 3600)) * 1000),
    address,
    name: typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null,
    consumer,
  };
}

/**
 * The IMAP and SMTP user for a grant. A personal Microsoft account signed in under an alias on
 * another domain (jean@empresa.com) has no Outlook.com mailbox there: IMAP answers "User is
 * authenticated but not connected" (19/10). The Outlook.com address the person typed before
 * signing in is used then; the token still decides which mailbox opens, so a wrong one is refused.
 */
export function mailboxExternalOAuthMailboxAddress(
  grant: { address: string; consumer: boolean },
  typed: string | null | undefined,
): string {
  const hint = typed?.trim().toLowerCase();
  return grant.consumer &&
    !MICROSOFT_CONSUMER_ADDRESS.test(grant.address) &&
    hint &&
    EMAIL.test(hint) &&
    MICROSOFT_CONSUMER_ADDRESS.test(hint)
    ? hint
    : grant.address;
}

/** A fresh access token from the refresh token (Microsoft may hand a new refresh token). */
export async function refreshMailboxExternalOAuthToken(
  provider: MailboxExternalOAuthProvider,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const answer = await tokenRequest(
    provider,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetcher,
  );
  return {
    accessToken: answer.access_token!,
    refreshToken: answer.refresh_token || refreshToken,
    expiresAt: new Date(now + Math.max(60, Number(answer.expires_in ?? 3600)) * 1000),
  };
}

/** The servers an OAuth account uses (fixed per provider; nothing the person types). */
export function mailboxExternalOAuthServers(
  provider: MailboxExternalOAuthProvider,
  grant: { address: string; consumer: boolean },
): MailboxExternalServersInput {
  return provider === "google"
    ? {
        provider: "gmail",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        username: grant.address,
      }
    : {
        provider: "outlook",
        imapHost: "outlook.office365.com",
        smtpHost: grant.consumer ? "smtp-mail.outlook.com" : "smtp.office365.com",
        smtpPort: 587,
        smtpSecurity: "starttls",
        username: grant.address,
      };
}

/** What is sealed for an OAuth account: only the refresh token. */
export function mailboxExternalOAuthSecret(refreshToken: string): string {
  return JSON.stringify({ v: 1, refresh: refreshToken });
}

/** The refresh token inside a sealed OAuth secret, or null when it is not one. */
export function readMailboxExternalOAuthSecret(secret: string): string | null {
  try {
    const value = JSON.parse(secret) as { v?: unknown; refresh?: unknown };
    return value.v === 1 && typeof value.refresh === "string" && value.refresh
      ? value.refresh
      : null;
  } catch {
    return null;
  }
}

/** The schema's auth value for a provider. */
export function mailboxExternalOAuthAuth(provider: MailboxExternalOAuthProvider) {
  return provider === "google" ? ("oauth_google" as const) : ("oauth_microsoft" as const);
}

/** The provider behind an auth value, or null for an app password. */
export function mailboxExternalOAuthProviderOf(auth: string): MailboxExternalOAuthProvider | null {
  return auth === "oauth_google" ? "google" : auth === "oauth_microsoft" ? "microsoft" : null;
}
