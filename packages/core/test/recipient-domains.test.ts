import { describe, expect, it, vi } from "vitest";
import {
  checkRecipientDomains,
  type DomainCache,
  type DomainVerdict,
  type MxResolver,
  RECIPIENT_DOMAIN_CACHE_MAX,
  RECIPIENT_DOMAIN_CACHE_TTL_MS,
  RECIPIENT_DOMAIN_CONCURRENCY,
  recipientDomain,
  recipientDomainCheckOn,
} from "../src/recipient-domains.js";

/** Resolver stub that always publishes one MX record. */
const ok: MxResolver = async () => [{ exchange: "mx.example.net" }];

/** Resolver that fails with one DNS error code. */
const failing =
  (code: string): MxResolver =>
  async () => {
    throw Object.assign(new Error(code), { code });
  };

describe("checkRecipientDomains", () => {
  it("accepts a domain that publishes an MX record", async () => {
    expect(await checkRecipientDomains(["good.example"], { resolve: ok })).toEqual([
      { domain: "good.example", ok: true },
    ]);
  });

  it("refuses a domain the resolver answers NXDOMAIN for", async () => {
    expect(
      await checkRecipientDomains(["gone.example"], { resolve: failing("ENOTFOUND") }),
    ).toEqual([{ domain: "gone.example", ok: false, reason: "nxdomain" }]);
    // Some resolvers answer the bare NXDOMAIN code, and its case varies.
    expect(await checkRecipientDomains(["nx.example"], { resolve: failing("nxdomain") })).toEqual([
      { domain: "nx.example", ok: false, reason: "nxdomain" },
    ]);
  });

  it("refuses a domain that publishes no MX record at all", async () => {
    const empty: MxResolver = async () => [];
    expect(await checkRecipientDomains(["parked.example"], { resolve: empty })).toEqual([
      { domain: "parked.example", ok: false, reason: "no_mx" },
    ]);
    // RFC 7505 null MX: one record pointing at the root.
    const nullMx: MxResolver = async () => [{ exchange: "." }];
    expect(await checkRecipientDomains(["nomail.example"], { resolve: nullMx })).toEqual([
      { domain: "nomail.example", ok: false, reason: "no_mx" },
    ]);
    // ENODATA is the resolver's definitive "this name has no MX".
    expect(
      await checkRecipientDomains(["nodata.example"], { resolve: failing("ENODATA") }),
    ).toEqual([{ domain: "nodata.example", ok: false, reason: "no_mx" }]);
  });

  it("FAILS OPEN on a resolver error, so an outage never blocks legitimate mail", async () => {
    for (const code of ["SERVFAIL", "ECONNREFUSED", "EREFUSED", "EAI_AGAIN", "ETIMEOUT"]) {
      expect(await checkRecipientDomains(["fine.example"], { resolve: failing(code) })).toEqual([
        { domain: "fine.example", ok: true, reason: "dns_error" },
      ]);
    }
    const boom: MxResolver = async () => {
      throw new Error("resolver exploded");
    };
    expect(await checkRecipientDomains(["fine.example"], { resolve: boom })).toEqual([
      { domain: "fine.example", ok: true, reason: "dns_error" },
    ]);
  });

  it("FAILS OPEN when a lookup hangs past the per-domain timeout", async () => {
    const hang: MxResolver = () => new Promise(() => undefined);
    const started = Date.now();
    const verdicts = await checkRecipientDomains(["slow.example"], {
      resolve: hang,
      timeoutMs: 20,
    });
    expect(verdicts).toEqual([{ domain: "slow.example", ok: true, reason: "dns_error" }]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("resolves each distinct domain once and reuses the cache afterwards", async () => {
    const cache: DomainCache = new Map();
    const calls: string[] = [];
    const resolve: MxResolver = async (domain) => {
      calls.push(domain);
      return [{ exchange: `mx.${domain}` }];
    };

    // Duplicates and case/root-dot variants collapse to one lookup.
    const first = await checkRecipientDomains(
      ["a.example", "A.Example.", "a.example", "b.example"],
      { resolve, cache },
    );
    expect(first).toEqual([
      { domain: "a.example", ok: true },
      { domain: "b.example", ok: true },
    ]);
    expect(calls).toEqual(["a.example", "b.example"]);

    const second = await checkRecipientDomains(["a.example", "b.example"], { resolve, cache });
    expect(second).toEqual(first);
    // The second call resolved nothing: the cache answered both.
    expect(calls).toEqual(["a.example", "b.example"]);
  });

  it("caches a refusal too, and lets an expired entry resolve again", async () => {
    const cache: DomainCache = new Map();
    const resolve = failing("ENOTFOUND");
    await checkRecipientDomains(["dead.example"], { resolve, cache });
    const calls: string[] = [];
    const counting: MxResolver = async (domain) => {
      calls.push(domain);
      return [{ exchange: "mx.example.net" }];
    };
    // Still cached as invalid: a refusal is a fact worth ten minutes.
    expect(await checkRecipientDomains(["dead.example"], { resolve: counting, cache })).toEqual([
      { domain: "dead.example", ok: false, reason: "nxdomain" },
    ]);
    expect(calls).toEqual([]);

    cache.set("stale.example", {
      v: { domain: "stale.example", ok: false, reason: "nxdomain" },
      at: Date.now() - RECIPIENT_DOMAIN_CACHE_TTL_MS - 1,
    });
    expect(await checkRecipientDomains(["stale.example"], { resolve: counting, cache })).toEqual([
      { domain: "stale.example", ok: true },
    ]);
    expect(calls).toEqual(["stale.example"]);
  });

  it("keeps the cache bounded, dropping the oldest entry first", async () => {
    const cache: DomainCache = new Map();
    const now = Date.now();
    for (let i = 0; i < RECIPIENT_DOMAIN_CACHE_MAX; i += 1) {
      const domain = `filler-${i}.example`;
      const v: DomainVerdict = { domain, ok: true };
      cache.set(domain, { v, at: now });
    }
    await checkRecipientDomains(["fresh.example"], { resolve: ok, cache });
    expect(cache.size).toBe(RECIPIENT_DOMAIN_CACHE_MAX);
    expect(cache.has("fresh.example")).toBe(true);
    expect(cache.has("filler-0.example")).toBe(false);
    expect(cache.has("filler-1.example")).toBe(true);
  });

  it("bounds concurrency, so a 21k-recipient blast cannot open 21k lookups", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const resolve: MxResolver = async (domain) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seen.push(domain);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [{ exchange: "mx.example.net" }];
    };

    const domains = Array.from({ length: 40 }, (_, i) => `d${i}.example`);
    const verdicts = await checkRecipientDomains(domains, { resolve });
    expect(verdicts).toHaveLength(40);
    expect(verdicts.every((v) => v.ok)).toBe(true);
    expect(seen).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(RECIPIENT_DOMAIN_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("reads the domain after the last @, whatever the display name says", () => {
    expect(recipientDomain("bob@example.com")).toBe("example.com");
    expect(recipientDomain("Bob <Bob@Example.COM>")).toBe("example.com");
    expect(recipientDomain("  bob@example.com. ")).toBe("example.com");
    expect(recipientDomain('"a@b" <bob@example.com>')).toBe("example.com");
    expect(recipientDomain("not-an-address")).toBe("");
  });

  it("is disabled only by RECIPIENT_DOMAIN_CHECK=off", () => {
    try {
      // Absent or empty keeps the gate on: the default must be protective.
      vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "");
      expect(recipientDomainCheckOn()).toBe(true);
      vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "on");
      expect(recipientDomainCheckOn()).toBe(true);
      expect(recipientDomainCheckOn("")).toBe(true);
      expect(recipientDomainCheckOn("1")).toBe(true);
      expect(recipientDomainCheckOn(" off ")).toBe(false);
      expect(recipientDomainCheckOn("OFF")).toBe(false);
      vi.stubEnv("RECIPIENT_DOMAIN_CHECK", "off");
      expect(recipientDomainCheckOn()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
