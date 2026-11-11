import { resolveMx } from "node:dns/promises";

/**
 * Verdict for one recipient domain.
 *
 * `ok: false` means the domain cannot receive mail at all: it does not exist
 * (NXDOMAIN) or it publishes no MX record. `reason: "dns_error"` rides on
 * `ok: true` on purpose — a resolver failure, a timeout or an exception must
 * never block legitimate mail, so it is reported for observability but not
 * enforced downstream.
 */
export type DomainVerdict = {
  domain: string;
  ok: boolean;
  reason?: "nxdomain" | "no_mx" | "dns_error";
};

/**
 * Injectable MX lookup so tests never touch real DNS. The default is
 * `node:dns/promises` `resolveMx`; a stub returns either its own objects with
 * an `exchange` field or bare host strings.
 */
export type MxResolver = (
  domain: string,
) => Promise<{ entryType?: string; exchange?: string }[] | string[]>;

/** Entry shape of the shared cache. `at` is when the verdict was resolved. */
export type DomainCache = Map<string, { v: DomainVerdict; at: number }>;

/** Per-domain DNS budget: an accept never waits longer than this for one domain. */
export const RECIPIENT_DOMAIN_TIMEOUT_MS = 2_000;
/** Parallel lookups inside one accept; a 21k-recipient blast is batched in eights. */
export const RECIPIENT_DOMAIN_CONCURRENCY = 8;
/** A domain's verdict is reused for ten minutes: bursts hit the same MX records. */
export const RECIPIENT_DOMAIN_CACHE_TTL_MS = 10 * 60_000;
/** Cache ceiling; past it the oldest inserted entry is dropped. */
export const RECIPIENT_DOMAIN_CACHE_MAX = 5_000;
/** Invalid recipients an accept tolerates before refusing the whole batch. */
export const RECIPIENT_DOMAIN_INVALID_MAX = 50;
/** Invalid share of the batch an accept tolerates (10%): a cold list fails wholesale. */
export const RECIPIENT_DOMAIN_INVALID_RATE = 0.1;

class DomainTimeoutError extends Error {}

const defaultResolver: MxResolver = (domain) => resolveMx(domain);

/**
 * Domain part of a recipient as given on the wire: text after the LAST `@`,
 * lowercased, display name and closing angle bracket dropped, trailing root
 * dot removed. Empty when the input carries no `@` — callers treat that as
 * "no domain to check" rather than inventing one.
 */
export function recipientDomain(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address
    .slice(at + 1)
    .trim()
    .replace(/>+$/, "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
}

/** Canonical cache key for a bare domain. */
function normalizeDomain(domain: string): string {
  return domain.trim().replace(/\.$/, "").toLowerCase();
}

/**
 * `RECIPIENT_DOMAIN_CHECK=off` disables the gate; every other value, and an
 * absent variable, keeps it on. Same reading as the repo's other core toggles
 * (a plain env read, no schema dependency from packages/core).
 */
export function recipientDomainCheckOn(
  raw: string | undefined = process.env.RECIPIENT_DOMAIN_CHECK,
): boolean {
  return raw?.trim().toLowerCase() !== "off";
}

function exchangeOf(record: { exchange?: string | undefined } | string | undefined): string {
  if (typeof record === "string") return record.trim();
  return record?.exchange?.trim() ?? "";
}

function dnsCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function cacheGet(cache: DomainCache, domain: string, now: number): DomainVerdict | undefined {
  const hit = cache.get(domain);
  if (!hit) return undefined;
  if (now - hit.at > RECIPIENT_DOMAIN_CACHE_TTL_MS) {
    cache.delete(domain);
    return undefined;
  }
  return hit.v;
}

function cacheSet(cache: DomainCache, verdict: DomainVerdict, now: number): void {
  if (cache.size >= RECIPIENT_DOMAIN_CACHE_MAX) {
    // A Map iterates in insertion order, so the first keys are the oldest.
    const excess = cache.size - RECIPIENT_DOMAIN_CACHE_MAX + 1;
    let dropped = 0;
    for (const key of cache.keys()) {
      if (dropped >= excess) break;
      cache.delete(key);
      dropped += 1;
    }
  }
  cache.set(verdict.domain, { v: verdict, at: now });
}

/** One domain, bounded by `timeoutMs`, classified; never throws. */
async function resolveVerdict(
  domain: string,
  resolve: MxResolver,
  timeoutMs: number,
): Promise<DomainVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = Promise.resolve(resolve(domain));
    // The losing side of the race must not surface as an unhandled rejection.
    lookup.catch(() => undefined);
    const records = await Promise.race([
      lookup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DomainTimeoutError(domain)), timeoutMs);
      }),
    ]);
    const usable = (records ?? [])
      .map((record) => exchangeOf(record))
      .filter((exchange) => exchange.length > 0 && exchange !== ".");
    if (usable.length === 0) return { domain, ok: false, reason: "no_mx" };
    return { domain, ok: true };
  } catch (error) {
    const code = dnsCode(error);
    // A definitive negative answer, not an outage: this is the domain that
    // would hard-bounce every message sent to it.
    if (code === "ENOTFOUND" || code === "NXDOMAIN") {
      return { domain, ok: false, reason: "nxdomain" };
    }
    // ENODATA ("no data of the requested type") is the resolver saying the
    // domain exists but has no MX record — equally definitive.
    if (code === "ENODATA") return { domain, ok: false, reason: "no_mx" };
    // FAIL-OPEN: timeout, SERVFAIL, refused, resolver misconfiguration,
    // anything else. Legitimate mail must not be refused because our DNS
    // view was briefly broken.
    return { domain, ok: true, reason: "dns_error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Runs `worker` over `items` with at most `limit` concurrent calls. */
async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * Resolves the MX verdict of every distinct domain in `domains`, in
 * first-appearance order (one verdict per distinct domain, so callers build a
 * Map from the result).
 *
 * FAIL-OPEN by contract: only a definitive DNS answer blocks — NXDOMAIN, or a
 * domain that publishes no MX. Any timeout, error or unexpected shape yields
 * `{ ok: true, reason: "dns_error" }`, because refusing mail on a resolver
 * wobble would be a worse failure than the one this gate prevents.
 */
export async function checkRecipientDomains(
  domains: string[],
  opts: {
    resolve?: MxResolver | undefined;
    timeoutMs?: number | undefined;
    cache?: DomainCache | undefined;
  } = {},
): Promise<DomainVerdict[]> {
  const resolve = opts.resolve ?? defaultResolver;
  const timeoutMs = opts.timeoutMs ?? RECIPIENT_DOMAIN_TIMEOUT_MS;
  const cache = opts.cache;

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    if (domain.length === 0 || seen.has(domain)) continue;
    seen.add(domain);
    unique.push(domain);
  }

  const now = Date.now();
  const verdicts = new Map<string, DomainVerdict>();
  const pending: string[] = [];
  for (const domain of unique) {
    const cached = cache ? cacheGet(cache, domain, now) : undefined;
    if (cached) verdicts.set(domain, cached);
    else pending.push(domain);
  }

  await runBounded(pending, RECIPIENT_DOMAIN_CONCURRENCY, async (domain) => {
    const verdict = await resolveVerdict(domain, resolve, timeoutMs);
    verdicts.set(domain, verdict);
    if (cache) cacheSet(cache, verdict, Date.now());
  });

  return unique.map((domain) => verdicts.get(domain) ?? { domain, ok: true, reason: "dns_error" });
}
