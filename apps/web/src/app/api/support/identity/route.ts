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
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/**
 * The support chat's verified identity for the signed-in user: a 10-minute
 * token the Elozi widget sends in a POST body. Same-origin only; nothing is
 * stored. 404 while the channel key is not configured, so the chat falls back
 * to the visitor flow.
 */
export async function GET(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return new Response(null, { status: 403, headers: NO_STORE });
  const key = eloziIdentityKey();
  if (!key) return new Response(null, { status: 404, headers: NO_STORE });
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
  if (!claims) return new Response(null, { status: 404, headers: NO_STORE });
  return Response.json({ token: signEloziIdentity(claims, key) }, { headers: NO_STORE });
}
