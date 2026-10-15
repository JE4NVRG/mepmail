import { getDb } from "@millionsend/db";
import { getLocale } from "next-intl/server";
import { getAuth } from "@/server/auth";
import { ACTIVE_TEAM_COOKIE } from "@/server/membership";
import {
  eloziIdentityKey,
  signEloziIdentity,
  supportIdentityClaims,
} from "@/server/support-identity";

const NO_STORE = { "cache-control": "private, no-store" };

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return "";
      } // Invalid selection fails closed during membership validation.
    }
  }
  return undefined;
}

/**
 * The support chat's verified identity for the signed-in user: a 10-minute
 * token the Elozi widget sends in a POST body. Same-origin only; nothing is
 * stored. A signed-in chat never downgrades to a visitor when identity fails.
 * Expected account/user are concurrency guards; the cookie and live membership authorize.
 */
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return new Response(null, { status: 403, headers: NO_STORE });
  const key = eloziIdentityKey();
  if (!key) return new Response(null, { status: 503, headers: NO_STORE });
  const session = await getAuth()
    .api.getSession({ headers: request.headers })
    .catch(() => null);
  if (!session) return new Response(null, { status: 401, headers: NO_STORE });
  const claims = await supportIdentityClaims(
    getDb(),
    {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      emailVerified: session.user.emailVerified === true,
    },
    await getLocale(),
    cookie(request, ACTIVE_TEAM_COOKIE),
  );
  if (!claims || !claims.email_verified) {
    return new Response(null, { status: 403, headers: NO_STORE });
  }
  const expected = new URL(request.url).searchParams;
  if (
    (expected.has("accountId") && expected.get("accountId") !== claims.accountId) ||
    (expected.has("userId") && expected.get("userId") !== claims.sub)
  ) {
    return new Response(null, { status: 409, headers: NO_STORE });
  }
  return Response.json(
    {
      token: signEloziIdentity(claims, key),
      identity: { accountId: claims.accountId, userId: claims.sub },
    },
    { headers: NO_STORE },
  );
}
