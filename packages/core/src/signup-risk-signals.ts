import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { registrableDomain } from "./org-domain.js";
import disposableData from "./signup-risk-data/disposable-domains.json" with { type: "json" };
import rdapBootstrap from "./signup-risk-data/rdap-dns.json" with { type: "json" };
import type { SignupRiskSignals } from "./signup-risk-policy.js";

const DISPOSABLE = new Set(disposableData.domains);
const MAX_RDAP_BYTES = 128 * 1024;
const BUDGET_MS = 2_000;
const DAY_MS = 86_400_000;
const COMPLETE_FACTS_TTL_MS = 10 * 60_000;
const INCOMPLETE_FACTS_TTL_MS = 30_000;

function reservedDomain(domain: string): boolean {
  return [
    "example.com",
    "example.net",
    "example.org",
    "test",
    "invalid",
    "example",
    "localhost",
    "local",
    "internal",
    "onion",
    "alt",
    "home.arpa",
  ].some((name) => domain === name || domain.endsWith(`.${name}`));
}

function disposableDomain(domain: string): boolean {
  const labels = domain.split(".");
  return labels.some((_, index) => DISPOSABLE.has(labels.slice(index).join(".")));
}

export interface SignupRiskLookups {
  resolveMx?: (
    domain: string,
    signal: AbortSignal,
  ) => Promise<readonly { exchange: string; priority: number }[]>;
  resolveTxt?: (name: string, signal: AbortSignal) => Promise<readonly (readonly string[])[]>;
  fetch?: typeof globalThis.fetch;
}
export interface CollectSignupRiskInput {
  email: string;
  ip?: string;
  secret: string;
  now?: Date;
  lookups?: SignupRiskLookups;
}

/** Canonical ASCII DNS name only: never an IP literal, URL, port or path. */
export function signupEmailDomain(email: string): string | null {
  if (email.length > 320 || email.trim() !== email || email.split("@").length !== 2) return null;
  const raw = email.slice(email.lastIndexOf("@") + 1);
  if (
    !raw ||
    /[\s/\\%:#?[\]<>]/.test(raw) ||
    [...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return null;
  const domain = domainToASCII(raw).toLowerCase();
  if (
    domain.length > 253 ||
    isIP(domain) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain)
  )
    return null;
  return domain;
}

function ipv6Words(ip: string): [number, number, number, number, number, number, number, number] {
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((x) =>
    Number.parseInt(x, 16),
  ) as [number, number, number, number, number, number, number, number];
}

/** Reject non-public/special-use input before emitting any DNS query. */
export function signupPublicIp(ip: string | undefined): string | null {
  if (!ip || ip.trim() !== ip || ip.includes("%")) return null;
  const version = isIP(ip);
  if (version === 6) {
    const words = ipv6Words(ip);
    if (words.slice(0, 5).every((x) => x === 0) && words[5] === 0xffff) {
      return signupPublicIp(
        `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`,
      );
    }
    // Global unicast only; special-purpose/documentation/transition ranges stay unknown.
    if (
      (words[0] & 0xe000) !== 0x2000 ||
      (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) ||
      words[0] === 0x2002 ||
      (words[0] === 0x3fff && (words[1] & 0xf000) === 0)
    )
      return null;
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  }
  if (version !== 4) return null;
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
  if (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
    return null;
  return ip;
}

/** Team Cymru's fixed DNS service: full reverse IPv6 nibbles, never a caller hostname. */
export function signupAsnQuery(ip: string): string | null {
  const publicIp = signupPublicIp(ip);
  if (!publicIp) return null;
  if (isIP(publicIp) === 4)
    return `${publicIp.split(".").reverse().join(".")}.origin.asn.cymru.com`;
  return `${ipv6Words(publicIp)
    .map((x) => x.toString(16).padStart(4, "0"))
    .join("")
    .split("")
    .reverse()
    .join(".")}.origin6.asn.cymru.com`;
}

/** Pinned IANA bootstrap only. Responses cannot nominate another server or URL. */
export function signupRdapUrl(domain: string): string | null {
  if (signupEmailDomain(`x@${domain}`) !== domain) return null;
  const name = registrableDomain(domain);
  const tld = name.split(".").at(-1);
  for (const [suffixes, servers] of rdapBootstrap.services) {
    if (!suffixes?.includes(tld ?? "")) continue;
    for (const server of servers ?? []) {
      try {
        const base = new URL(server);
        if (
          base.protocol !== "https:" ||
          base.username ||
          base.password ||
          base.port ||
          base.search ||
          base.hash ||
          isIP(base.hostname) ||
          signupEmailDomain(`x@${base.hostname}`) !== base.hostname ||
          !/^\/[a-zA-Z0-9_./-]*$/.test(base.pathname) ||
          base.pathname.split("/").some((part) => part === "." || part === "..")
        )
          continue;
        if (!base.pathname.endsWith("/")) base.pathname += "/";
        const target = new URL(`domain/${name}`, base);
        if (target.origin !== base.origin || target.pathname !== `${base.pathname}domain/${name}`)
          continue;
        return target.href;
      } catch {
        /* Unsupported bootstrap entry remains unknown. */
      }
    }
  }
  return null;
}

function randomLocal(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@"));
  // A readable name followed by a year or a short number is common in human
  // addresses. It must not become an identity signal just for containing digits.
  if (/^[a-z]{3,}[0-9]{1,4}$/i.test(local)) return false;
  if (/^[a-f0-9]{16,64}$/i.test(local)) return true;
  return /^[a-z0-9]{8,64}$/i.test(local) && /[a-z]/i.test(local) && /[0-9]/.test(local);
}

const BUSINESS_SUFFIX =
  "(?:antique|craft|mercantile|boutique|jewelry|jewellery|store|shop|floral|farm|bakery|furniture|lumber|aquatic|coffee|tools|supplies|events|market)s?";
const GENERIC_BUSINESS_NAME = new RegExp(`(?:\\b${BUSINESS_SUFFIX}\\b|${BUSINESS_SUFFIX}$)`);

/** Weak name-template signal; return only the boolean, never the original name. */
export function signupGenericTeamName(name: string): boolean {
  if (!name || name.length > 256) return false;
  const normalized = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (
    /^(?:(?:minha|my|online|test|teste) )?(?:loja|shop|store|team|equipe)(?: (?:online|virtual|test|teste|[0-9]{1,6}))?$/.test(
      normalized,
    )
  )
    return true;
  // Common business suffixes are weak corroboration only, never a label that
  // this actual business or its owner is abusive.
  return (
    normalized.length >= 6 && normalized.length <= 64 && GENERIC_BUSINESS_NAME.test(normalized)
  );
}

async function dnsMx(domain: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 650, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await resolver.resolveMx(domain);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
async function dnsTxt(query: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 650, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await resolver.resolveTxt(query);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function bounded<T>(fn: () => Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return fallback;
  return new Promise((resolve) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(fallback);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(signal.aborted ? fallback : value);
        },
        () => {
          signal.removeEventListener("abort", abort);
          resolve(fallback);
        },
      );
  });
}

type DomainFacts = { mx: SignupRiskSignals["mx"]; registeredAt: number | null };
type CacheEntry<T> = { expiresAt: number; promise: Promise<T> };

/** A collector owns bounded caches; dependency-injected tests get isolated instances. */
export function createSignupRiskSignalCollector(
  lookups: SignupRiskLookups = {},
  options: { timeoutMs?: number; maxCacheEntries?: number } = {},
) {
  const requestedBudget = options.timeoutMs ?? BUDGET_MS;
  const requestedLimit = options.maxCacheEntries ?? 512;
  const budget =
    Number.isFinite(requestedBudget) && requestedBudget > 0
      ? Math.min(BUDGET_MS, requestedBudget)
      : BUDGET_MS;
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(1_024, requestedLimit) : 512;
  const domains = new Map<string, CacheEntry<DomainFacts>>();
  const asns = new Map<string, CacheEntry<number | null>>();
  function cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    load: () => Promise<T>,
    ttl: (value: T) => number = () => COMPLETE_FACTS_TTL_MS,
  ): Promise<T> {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.promise;
    if (entry) cache.delete(key);
    while (cache.size >= limit) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    const promise = load().then((value) => {
      const current = cache.get(key);
      // An evicted, slow lookup must not replace a more recent observation.
      if (current?.promise === promise) current.expiresAt = Date.now() + ttl(value);
      return value;
    });
    cache.set(key, { expiresAt: Date.now() + COMPLETE_FACTS_TTL_MS, promise });
    return promise;
  }
  async function mx(domain: string, signal: AbortSignal): Promise<SignupRiskSignals["mx"]> {
    try {
      const records = await (lookups.resolveMx ?? dnsMx)(domain, signal);
      if (records.length === 0) return "absent";
      if (records.length > 256) return "unknown";
      if (
        records.length === 1 &&
        records[0]?.priority === 0 &&
        ["", "."].includes(records[0].exchange)
      )
        return "null";
      return records.every(
        (r) =>
          Number.isInteger(r.priority) &&
          r.priority >= 0 &&
          r.priority <= 65535 &&
          signupEmailDomain(`x@${r.exchange.replace(/\.$/, "")}`),
      )
        ? "present"
        : "unknown";
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      return code === "ENODATA" || code === "ENOTFOUND" ? "absent" : "unknown";
    }
  }
  async function registration(domain: string, signal: AbortSignal): Promise<number | null> {
    const url = signupRdapUrl(domain);
    if (!url) return null;
    const response = await (lookups.fetch ?? globalThis.fetch)(url, {
      signal,
      redirect: "error",
      headers: { Accept: "application/rdap+json, application/json" },
    });
    const rejectResponse = async (): Promise<null> => {
      await response.body?.cancel().catch(() => {});
      return null;
    };
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url))
      return rejectResponse();
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/rdap+json" && contentType !== "application/json")
      return rejectResponse();
    if (Number(response.headers.get("content-length") ?? "0") > MAX_RDAP_BYTES || !response.body)
      return rejectResponse();
    const reader = response.body.getReader();
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_RDAP_BYTES) return null;
        chunks.push(chunk.value);
      }
      if (signal.aborted) return null;
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        ldhName?: unknown;
        events?: unknown;
      };
      if (
        typeof value.ldhName !== "string" ||
        value.ldhName.toLowerCase() !== registrableDomain(domain) ||
        !Array.isArray(value.events)
      )
        return null;
      // Keep only the earliest registration instant. Ignore entities, links and owner details.
      const dates = value.events.flatMap((event: unknown) => {
        if (!event || typeof event !== "object") return [];
        const e = event as { eventAction?: unknown; eventDate?: unknown };
        if (e.eventAction !== "registration" || typeof e.eventDate !== "string") return [];
        const parsed = Date.parse(e.eventDate);
        return Number.isFinite(parsed) ? [parsed] : [];
      });
      return dates.length ? Math.min(...dates) : null;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  async function asn(ip: string, signal: AbortSignal): Promise<number | null> {
    const query = signupAsnQuery(ip);
    if (!query) return null;
    const rows = await (lookups.resolveTxt ?? dnsTxt)(query, signal);
    if (rows.length > 8) return null;
    const numbers = new Set<number>();
    for (const row of rows) {
      const text = row.join("");
      if (text.length > 512) return null;
      const field = text.split("|", 1)[0]?.trim() ?? "";
      if (!/^\d{1,10}$/.test(field)) return null;
      const number = Number(field);
      if (number < 1 || number > 4_294_967_295) return null;
      numbers.add(number);
    }
    return numbers.size === 1 ? ([...numbers][0] ?? null) : null;
  }
  return async (input: Omit<CollectSignupRiskInput, "lookups">): Promise<SignupRiskSignals> => {
    const domain = signupEmailDomain(input.email);
    const networkAllowed = domain !== null && !reservedDomain(domain);
    const ip = signupPublicIp(input.ip);
    if (ip && !input.secret) throw new Error("signup_risk_secret_required");
    const ipKey = ip
      ? createHmac("sha256", input.secret).update(`mepmail-signup-risk:v1\0${ip}`).digest("hex")
      : null;
    const signal = new AbortController();
    const timer = setTimeout(() => signal.abort(), budget);
    timer.unref();
    try {
      const [facts, network] = await Promise.all([
        domain && networkAllowed
          ? cached(
              domains,
              domain,
              async () => {
                const [mxState, registeredAt] = await Promise.all([
                  bounded(() => mx(domain, signal.signal), "unknown" as const, signal.signal),
                  bounded(() => registration(domain, signal.signal), null, signal.signal),
                ]);
                return { mx: mxState, registeredAt };
              },
              (value) =>
                value.mx === "unknown" || value.registeredAt === null
                  ? INCOMPLETE_FACTS_TTL_MS
                  : COMPLETE_FACTS_TTL_MS,
            )
          : Promise.resolve({ mx: "unknown" as const, registeredAt: null }),
        ip && ipKey && networkAllowed
          ? cached(
              asns,
              ipKey,
              () => bounded(() => asn(ip, signal.signal), null, signal.signal),
              (value) => (value === null ? INCOMPLETE_FACTS_TTL_MS : COMPLETE_FACTS_TTL_MS),
            )
          : Promise.resolve(null),
      ]);
      const age =
        facts.registeredAt === null
          ? null
          : ((input.now ?? new Date()).getTime() - facts.registeredAt) / DAY_MS;
      return {
        domain: domain ?? "",
        disposable: domain !== null && disposableDomain(domain),
        mx: facts.mx,
        domainAgeDays: age !== null && Number.isFinite(age) && age >= 0 ? Math.floor(age) : null,
        catchAll: "unknown",
        randomLocal: domain !== null && randomLocal(input.email),
        ipKey,
        asn: network,
        signupsIp1h: 0,
        signupsDomain24h: 0,
        signupsAsn1h: 0,
        verificationSeconds: null,
        genericTeamName: false,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

const defaultCollector = createSignupRiskSignalCollector();
export async function collectSignupRiskSignals(
  input: CollectSignupRiskInput,
): Promise<SignupRiskSignals> {
  return input.lookups
    ? createSignupRiskSignalCollector(input.lookups)(input)
    : defaultCollector(input);
}
