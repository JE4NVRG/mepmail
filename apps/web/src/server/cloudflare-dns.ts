/**
 * "Configurar na Cloudflare" on the domain page: the person pastes a Cloudflare
 * API token limited to DNS on their zone and we write the records the domain
 * needs. The token is used for this one request only: it is not stored, logged
 * or echoed back. The API host is fixed, never one the browser names.
 *
 * Each record is written only where it cannot break anything the person
 * already has: our own DKIM selector and MAIL FROM host may be replaced, an
 * SPF or CNAME that differs is reported and left alone, and DMARC is only ever
 * created where none exists. The sending setup never touches the domain's MX
 * (where the person receives mail); the Correio receiving setup only creates it
 * where the name has none, and never replaces one.
 */

import { CLOUDFLARE_TOKEN } from "@/lib/cloudflare";

export { CLOUDFLARE_TOKEN };

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;

/**
 * How a desired record may be written:
 * - `own`: our DKIM selector; an older DKIM key there (from a domain added
 *   before) is replaced.
 * - `mailFromMx`: the MAIL FROM host; an MX that already points at SES in
 *   another region is replaced, any other MX is a conflict.
 * - `spf`: one SPF per name; a different one is a conflict (two would break it).
 * - `createOnly`: DMARC; written only when the name has none.
 * - `cname`: the tracking host; a different target is a conflict.
 * - `receivingMx`: Correio receiving; created only where the name has no MX. Ours,
 *   at any priority, stays as it is; any other MX (Google, Purelymail, a host that
 *   receives today) is a conflict and is never replaced or removed.
 */
export type CloudflareRecordPolicy =
  | "own"
  | "mailFromMx"
  | "spf"
  | "createOnly"
  | "cname"
  | "receivingMx";

export interface CloudflareDesiredRecord {
  type: "TXT" | "MX" | "CNAME";
  name: string;
  /** As shown in the records table: TXT values carry their quotes. */
  value: string;
  priority?: number;
  policy: CloudflareRecordPolicy;
}

export type CloudflareRecordOutcome = "created" | "updated" | "unchanged" | "conflict" | "failed";

export interface CloudflareRecordResult {
  type: CloudflareDesiredRecord["type"];
  name: string;
  outcome: CloudflareRecordOutcome;
}

export type CloudflareSetupResult =
  | { ok: true; zone: string; records: CloudflareRecordResult[] }
  | {
      ok: false;
      reason: "rejected" | "forbidden" | "zone_not_found" | "unreachable" | "unexpected";
    };

type Fetch = typeof fetch;

interface ExistingRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

interface ApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number }[];
}

class CloudflareFailure extends Error {
  constructor(readonly reason: "rejected" | "forbidden" | "unexpected") {
    super(reason);
  }
}

/** Cloudflare error codes for a token that is malformed, unknown, expired or revoked. */
const TOKEN_ERRORS = new Set([6003, 6111, 9106, 10000]);
/** "Unauthorized to access requested resource": a valid token without this permission. */
const PERMISSION_ERRORS = new Set([9109]);

/** TXT content as one string: quotes off, split character strings joined. */
export function txtText(content: string): string {
  return content.trim().replace(/"\s+"/g, "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
}

function hostName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function sameContent(type: string, a: string, b: string): boolean {
  return type === "TXT" ? txtText(a) === txtText(b) : hostName(a) === hostName(b);
}

/**
 * The zone that serves `domain`: its own zone if it is one (a delegated
 * subdomain), otherwise the parent zones up to and including `apex`.
 */
function zoneCandidates(domain: string, apex: string): string[] {
  const candidates: string[] = [];
  let labels = domain.toLowerCase().split(".");
  while (labels.length >= 2) {
    const name = labels.join(".");
    candidates.push(name);
    if (name === apex) break;
    labels = labels.slice(1);
  }
  return candidates;
}

export async function applyCloudflareRecords(
  input: {
    token: string;
    domain: string;
    /** The registrable domain: the zone search stops there. */
    apex: string;
    records: CloudflareDesiredRecord[];
  },
  deps: { fetch?: Fetch } = {},
): Promise<CloudflareSetupResult> {
  const { token, domain, apex, records } = input;
  if (!CLOUDFLARE_TOKEN.test(token)) return { ok: false, reason: "rejected" };
  const doFetch = deps.fetch ?? fetch;

  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await doFetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let payload: ApiEnvelope<T> | null = null;
    try {
      payload = (await res.json()) as ApiEnvelope<T>;
    } catch {
      payload = null;
    }
    const codes = (payload?.errors ?? []).map((error) => error.code ?? 0);
    if (codes.some((code) => PERMISSION_ERRORS.has(code))) throw new CloudflareFailure("forbidden");
    if (res.status === 401 || codes.some((code) => TOKEN_ERRORS.has(code)))
      throw new CloudflareFailure("rejected");
    if (res.status === 403) throw new CloudflareFailure("forbidden");
    if (!res.ok || !payload?.success) throw new CloudflareFailure("unexpected");
    return payload.result as T;
  };

  try {
    let zone: { id: string; name: string } | undefined;
    for (const candidate of zoneCandidates(domain, apex)) {
      const found = await call<{ id: string; name: string }[]>(
        `/zones?name=${encodeURIComponent(candidate)}&per_page=5`,
      );
      zone = found.find((entry) => entry.name.toLowerCase() === candidate);
      if (zone) break;
    }
    if (!zone) return { ok: false, reason: "zone_not_found" };
    const zoneId = encodeURIComponent(zone.id);

    const results: CloudflareRecordResult[] = [];
    for (const record of records) {
      const name = record.name.toLowerCase();
      const outcome = await (async (): Promise<CloudflareRecordOutcome> => {
        try {
          const existing = (
            await call<ExistingRecord[]>(
              `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(name)}&per_page=50`,
            )
          ).filter((entry) => entry.name.toLowerCase() === name && entry.type === record.type);
          const body = {
            type: record.type,
            name,
            content: record.value,
            ttl: 1,
            ...(record.type === "MX" ? { priority: record.priority ?? 10 } : {}),
            ...(record.type === "CNAME" ? { proxied: false } : {}),
            comment: "MepMail",
          };
          const matches = existing.some(
            (entry) =>
              sameContent(record.type, entry.content, record.value) &&
              (record.type !== "MX" ||
                record.policy === "receivingMx" ||
                entry.priority === (record.priority ?? 10)),
          );
          if (matches) return "unchanged";
          // Same-name records of the kind this policy may replace or must respect.
          const relevant = existing.filter((entry) => {
            const text = txtText(entry.content).toLowerCase();
            if (record.policy === "own") return text.startsWith("v=dkim1");
            if (record.policy === "spf") return text.startsWith("v=spf1");
            if (record.policy === "createOnly") return text.startsWith("v=dmarc1");
            return true;
          });
          if (relevant.length === 0) {
            await call(`/zones/${zoneId}/dns_records`, { method: "POST", body });
            return "created";
          }
          const replaceable =
            relevant.length === 1 &&
            (record.policy === "own" ||
              (record.policy === "mailFromMx" &&
                /\.amazonses\.com$/.test(hostName(relevant[0]?.content ?? ""))));
          if (!replaceable) return "conflict";
          await call(`/zones/${zoneId}/dns_records/${encodeURIComponent(relevant[0]?.id ?? "")}`, {
            method: "PATCH",
            body,
          });
          return "updated";
        } catch (error) {
          // A token or permission problem would fail every record the same way:
          // stop there. Anything else fails this record only.
          if (error instanceof CloudflareFailure && error.reason !== "unexpected") throw error;
          return "failed";
        }
      })();
      results.push({ type: record.type, name, outcome });
    }
    return { ok: true, zone: zone.name, records: results };
  } catch (error) {
    if (error instanceof CloudflareFailure)
      return { ok: false, reason: error.reason === "unexpected" ? "unexpected" : error.reason };
    return { ok: false, reason: "unreachable" };
  }
}
