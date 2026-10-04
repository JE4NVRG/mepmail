import {
  ADVERTISING_CONSENT_COOKIE,
  ADVERTISING_CONSENT_MAX_AGE,
  ADVERTISING_POLICY_VERSION,
  advertisingCookie,
  consentSameOrigin,
  decodeConsentProof,
  encodeConsentProof,
  readAdvertisingConsent,
  saveAdvertisingConsent,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import { getDb } from "@millionsend/db";
import { appOrigin } from "@/lib/api-base-url";
import { getAuth } from "@/server/auth";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
const proofFor = (request: Request) =>
  decodeConsentProof(
    advertisingCookie(request.headers.get("cookie"), ADVERTISING_CONSENT_COOKIE),
    env.BETTER_AUTH_SECRET ?? "",
  );

/** GET never creates a receipt/cookie and exposes no proof, matching cookie or private identity. */
export async function GET(request: Request) {
  try {
    const state = await readAdvertisingConsent(getDb(), proofFor(request));
    return Response.json(state, { headers: noStore });
  } catch {
    return Response.json(
      { state: "unknown", policyVersion: ADVERTISING_POLICY_VERSION },
      { status: 503, headers: noStore },
    );
  }
}

export async function POST(request: Request) {
  if (!consentSameOrigin(request, appOrigin()))
    return new Response(null, { status: 403, headers: noStore });
  // Keep the anonymous endpoint bounded. Nothing other than this choice is accepted from a browser.
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    return new Response(null, { status: 415 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 256) {
      await reader.cancel();
      return new Response(null, { status: 413 });
    }
    chunks.push(chunk.value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !("granted" in input) ||
    typeof input.granted !== "boolean" ||
    !("policyVersion" in input) ||
    input.policyVersion !== ADVERTISING_POLICY_VERSION
  )
    return new Response(null, { status: 400 });
  if (!env.BETTER_AUTH_SECRET) return new Response(null, { status: 503, headers: noStore });
  try {
    const session = input.granted
      ? await getAuth().api.getSession({ headers: request.headers })
      : null;
    const result = await saveAdvertisingConsent(getDb(), {
      granted: input.granted,
      proof: proofFor(request),
      userId: session?.user.id ?? null,
      sourceUrl: request.headers.get("referer"),
    });
    const cookie = `${ADVERTISING_CONSENT_COOKIE}=${encodeConsentProof(result.proof, env.BETTER_AUTH_SECRET)}; Path=/; Max-Age=${Math.min(ADVERTISING_CONSENT_MAX_AGE, Math.max(0, result.proof.expires - Math.floor(Date.now() / 1000)))}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
    return Response.json(
      { state: result.state, policyVersion: result.policyVersion },
      { headers: { ...noStore, "Set-Cookie": cookie } },
    );
  } catch {
    return Response.json(
      { state: "unknown", policyVersion: ADVERTISING_POLICY_VERSION },
      { status: 503, headers: noStore },
    );
  }
}
