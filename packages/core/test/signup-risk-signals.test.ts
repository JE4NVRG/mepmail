import { afterEach, describe, expect, it, vi } from "vitest";
import disposableData from "../src/signup-risk-data/disposable-domains.json" with { type: "json" };
import {
  collectSignupRiskSignals,
  createSignupRiskSignalCollector,
  type SignupRiskLookups,
  signupAsnQuery,
  signupEmailDomain,
  signupGenericTeamName,
  signupPublicIp,
  signupRdapUrl,
} from "../src/signup-risk-signals.js";

const SECRET = "synthetic-existing-auth-secret-32-bytes";
const NOW = new Date("2026-10-17T12:00:00.000Z");
const input = (email = "person@acme.com") => ({ email, secret: SECRET, now: NOW });
function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/rdap+json" },
  });
}
function dependencies() {
  const resolveMx = vi.fn(async (_domain: string, _signal: AbortSignal) => [
    { exchange: "mx.acme.com", priority: 10 },
  ]);
  const resolveTxt = vi.fn(async (_name: string, _signal: AbortSignal) => [
    ["15169 | 8.8.8.0/24 | US | arin | 1992-12-01"],
  ]);
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const name = new URL(String(url)).pathname.split("/domain/")[1];
    return jsonResponse({
      ldhName: name,
      events: [{ eventAction: "registration", eventDate: "2026-10-15T12:00:00.000Z" }],
      entities: [{ privateOwner: "never returned" }],
    });
  });
  const lookups: SignupRiskLookups = {
    resolveMx,
    resolveTxt,
    fetch: fetch as typeof globalThis.fetch,
  };
  return { resolveMx, resolveTxt, fetch, lookups };
}
afterEach(() => vi.useRealTimers());

describe("bounded signup signal collection", () => {
  it("pins the public disposable snapshot without treating prior operator holds as labels", () => {
    expect(disposableData.sourceSha256).toBe(
      "5052d5eebd1b8907738dbbf3f1f4cd961593c14f44435674bc6d8a34986009a7",
    );
    expect(disposableData.license).toBe("CC0-1.0");
    expect(disposableData.domains).toHaveLength(9892);
    expect(new Set(disposableData.domains).size).toBe(9892);
  });
  it("returns only facts, unknown catch-all and zero velocities without persisting an email or IP", async () => {
    const d = dependencies();
    const result = await collectSignupRiskSignals({
      ...input("a1b2c3d4e5@acme.com"),
      ip: "8.8.8.8",
      lookups: d.lookups,
    });
    expect(result).toMatchObject({
      domain: "acme.com",
      disposable: false,
      mx: "present",
      domainAgeDays: 2,
      catchAll: "unknown",
      randomLocal: true,
      asn: 15169,
      signupsIp1h: 0,
      signupsDomain24h: 0,
      signupsAsn1h: 0,
      verificationSeconds: null,
      genericTeamName: false,
    });
    expect(result.ipKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /a1b2c3d4e5@|8\.8\.8\.8|privateOwner|never returned/,
    );
    expect(d.resolveTxt.mock.calls[0]?.[0]).toBe("8.8.8.8.origin.asn.cymru.com");
    expect(d.fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    "Loja",
    "Minha Loja",
    "loja online",
    "My Store",
    "shop 123",
    "Sunny Acre Farms",
    "GoldenGateFloral",
    "Example Coffee Company",
    "ExampleBoutique",
  ])("returns a boolean weak signal for a common team-name template: %s", (name) =>
    expect(signupGenericTeamName(name)).toBe(true),
  );

  it.each([
    "",
    "Synthetic",
    "JE4NDEV",
    "Agência MEP",
    "Golden Gate Technology",
    "MyShopper",
    "Farmington Consulting",
    "x".repeat(257),
  ])("does not classify arbitrary company names as a template: %s", (name) =>
    expect(signupGenericTeamName(name)).toBe(false),
  );

  it.each(["q7mzkvra", "4gkz9wpt", "ab123456", "a1b2c3d4e5", "abcdefabcdefabcdef"])(
    "detects short mixed and opaque identities without persisting their local part: %s",
    async (local) => {
      const d = dependencies();
      const collector = createSignupRiskSignalCollector(d.lookups);
      const result = await collector(input(`${local}@acme.com`));
      expect(result.randomLocal).toBe(true);
      expect(JSON.stringify(result)).not.toContain(local);
    },
  );

  it.each([
    "carlos1988",
    "maria12",
    "alex1234",
    "person",
    "first.last2026",
    "user-name1",
    "a1b2c3d",
  ])(
    "keeps readable human address shapes and too-short mixtures out of random identity evidence: %s",
    async (local) => {
      const d = dependencies();
      const collector = createSignupRiskSignalCollector(d.lookups);
      expect((await collector(input(`${local}@acme.com`))).randomLocal).toBe(false);
    },
  );

  it("uses the pinned disposable snapshot including subdomains and no suffix lookalikes", async () => {
    const d = dependencies();
    const collector = createSignupRiskSignalCollector(d.lookups);
    expect((await collector(input("person@mailinator.com"))).disposable).toBe(true);
    expect((await collector(input("person@sub.mailinator.com"))).disposable).toBe(true);
    // notmailinator.com is itself on the pinned disposable list.
    expect((await collector(input("person@mailinator.com.lookalike.test"))).disposable).toBe(false);
    expect((await collector(input("a1b2c3d4e5@gmail.com"))).disposable).toBe(false);
  });

  it.each([
    "person@example.com",
    "person@sub.example.org",
    "person@company.test",
    "person@x.invalid",
    "person@host.localhost",
    "person@metadata.google.internal",
  ])("makes no network request for a reserved domain: %s", async (email) => {
    const d = dependencies();
    const result = await collectSignupRiskSignals({
      ...input(email),
      ip: "8.8.8.8",
      lookups: d.lookups,
    });
    expect(result).toMatchObject({
      mx: "unknown",
      domainAgeDays: null,
      asn: null,
      catchAll: "unknown",
    });
    expect(d.resolveMx).not.toHaveBeenCalled();
    expect(d.resolveTxt).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "x@localhost",
    "x@127.0.0.1",
    "x@[::1]",
    "x@good.com/evil",
    "x@good.com:443",
    "x@good.com%2fsecret",
    "x@user@good.com",
    "x@good.com\\evil",
  ])("rejects hostname/path injection before network: %s", async (email) => {
    const d = dependencies();
    expect(signupEmailDomain(email)).toBeNull();
    const result = await collectSignupRiskSignals({ ...input(email), lookups: d.lookups });
    expect(result.domain).toBe("");
    expect(d.resolveMx).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("normalizes IDN domains without accepting an arbitrary RDAP endpoint", () => {
    expect(signupEmailDomain("person@BÜCHER.de")).toBe("xn--bcher-kva.de");
    expect(signupRdapUrl("acme.com")).toMatch(/^https:\/\/[^/]+\/.*domain\/acme\.com$/);
    for (const domain of [
      "evil.com/path",
      "169.254.169.254",
      "foo.invalid",
      "good.com?url=http://127.0.0.1",
    ])
      expect(signupRdapUrl(domain)).toBeNull();
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "3fff::1",
    "::ffff:127.0.0.1",
    "fe80::1%eth0",
    "1::2::3",
  ])("never emits an ASN query for non-public or invalid IP %s", (ip) => {
    expect(signupPublicIp(ip)).toBeNull();
    expect(signupAsnQuery(ip)).toBeNull();
  });

  it("forms all 32 IPv6 reverse nibbles and canonicalizes IPv4-mapped IPv6", async () => {
    const expected = `${"20014860486000000000000000008888".split("").reverse().join(".")}.origin6.asn.cymru.com`;
    expect(signupAsnQuery("2001:4860:4860::8888")).toBe(expected);
    expect(signupPublicIp("::ffff:8.8.8.8")).toBe("8.8.8.8");
    const d = dependencies();
    const collector = createSignupRiskSignalCollector(d.lookups);
    const one = await collector({ ...input(), ip: "8.8.8.8" });
    const two = await collector({ ...input(), ip: "::ffff:8.8.8.8" });
    expect(one.ipKey).toBe(two.ipKey);
    expect(d.resolveTxt).toHaveBeenCalledTimes(1);
    const other = await collector({
      ...input(),
      ip: "8.8.8.8",
      secret: "another-synthetic-existing-secret",
    });
    expect(other.ipKey).not.toBe(one.ipKey);
  });

  it("requires a secret only for a public-IP HMAC, before issuing any lookup", async () => {
    const d = dependencies();
    const collector = createSignupRiskSignalCollector(d.lookups);
    await expect(collector({ ...input(), secret: "", ip: "8.8.8.8" })).rejects.toThrow(
      "signup_risk_secret_required",
    );
    expect(d.fetch).not.toHaveBeenCalled();
    expect((await collector({ ...input("person@example.com"), secret: "" })).ipKey).toBeNull();
  });

  it.each([
    { records: [], expected: "absent" },
    { records: [{ exchange: ".", priority: 0 }], expected: "null" },
    { records: [{ exchange: "mx.acme.com", priority: 10 }], expected: "present" },
    {
      records: [
        { exchange: ".", priority: 0 },
        { exchange: "mx.acme.com", priority: 10 },
      ],
      expected: "unknown",
    },
  ])(
    "distinguishes MX facts without inferring catch-all: $expected",
    async ({ records, expected }) => {
      const d = dependencies();
      const collector = createSignupRiskSignalCollector({
        ...d.lookups,
        resolveMx: async () => records,
      });
      expect(await collector(input())).toMatchObject({ mx: expected, catchAll: "unknown" });
    },
  );

  it.each([
    { code: "ENODATA", expected: "absent" },
    { code: "ENOTFOUND", expected: "absent" },
    { code: "ETIMEOUT", expected: "unknown" },
    { code: "ESERVFAIL", expected: "unknown" },
  ])("keeps DNS failure semantics: $code", async ({ code, expected }) => {
    const d = dependencies();
    const collector = createSignupRiskSignalCollector({
      ...d.lookups,
      resolveMx: async () => {
        throw Object.assign(new Error("synthetic lookup"), { code });
      },
    });
    expect((await collector(input())).mx).toBe(expected);
  });

  it.each(["redirect", "different_name", "server_link", "too_large", "future", "invalid_json"])(
    "does not trust an RDAP $s response",
    async (condition) => {
      const d = dependencies();
      d.lookups.fetch = vi.fn(async () => {
        if (condition === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/metadata" },
          });
        if (condition === "too_large")
          return new Response("x".repeat(128 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          });
        if (condition === "invalid_json")
          return new Response("{", { headers: { "content-type": "application/json" } });
        return jsonResponse({
          ldhName: condition === "different_name" ? "foreign.com" : "acme.com",
          links: [{ href: "http://127.0.0.1/secret" }],
          events:
            condition === "server_link"
              ? []
              : [{ eventAction: "registration", eventDate: "2030-01-01T00:00:00.000Z" }],
        });
      }) as typeof globalThis.fetch;
      const result = await collectSignupRiskSignals({ ...input(), lookups: d.lookups });
      expect(result.domainAgeDays).toBeNull();
      expect(d.lookups.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("returns unknown under the single deadline even when injected services ignore abort", async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const collector = createSignupRiskSignalCollector(
      { resolveMx: never, resolveTxt: never, fetch: never },
      { timeoutMs: 25 },
    );
    const pending = collector({ ...input(), ip: "8.8.8.8" });
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toMatchObject({ mx: "unknown", domainAgeDays: null, asn: null });
  });

  it("cancels an oversized advertised RDAP response without retaining its body", async () => {
    const d = dependencies();
    const cancel = vi.fn();
    d.lookups.fetch = async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "application/json", "content-length": String(128 * 1024 + 1) },
      });
    expect(
      (await collectSignupRiskSignals({ ...input(), lookups: d.lookups })).domainAgeDays,
    ).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("deduplicates cold work, expires cache entries and evicts within the configured bound", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    const collector = createSignupRiskSignalCollector(d.lookups, { maxCacheEntries: 2 });
    await Promise.all([
      collector(input("one@one-company.com")),
      collector(input("two@one-company.com")),
    ]);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await collector(input("one@two-company.com"));
    await collector(input("one@three-company.com"));
    await collector(input("one@one-company.com"));
    expect(d.fetch).toHaveBeenCalledTimes(4);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await collector(input("one@one-company.com"));
    expect(d.fetch).toHaveBeenCalledTimes(5);
  });

  it("retries incomplete domain facts after thirty seconds while retaining a recovered observation for ten minutes", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    d.resolveMx.mockRejectedValueOnce(
      Object.assign(new Error("synthetic timeout"), { code: "ETIMEOUT" }),
    );
    d.fetch.mockResolvedValueOnce(jsonResponse({ ldhName: "acme.com", events: [] }));
    const collector = createSignupRiskSignalCollector(d.lookups);
    expect(await collector(input())).toMatchObject({ mx: "unknown", domainAgeDays: null });
    await collector(input());
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await collector(input())).toMatchObject({ mx: "present", domainAgeDays: 2 });
    expect(d.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_001);
    await collector(input());
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries an unknown ASN without reloading complete domain facts", async () => {
    vi.useFakeTimers();
    const d = dependencies();
    d.resolveTxt.mockRejectedValueOnce(new Error("synthetic timeout"));
    const collector = createSignupRiskSignalCollector(d.lookups);
    expect((await collector({ ...input(), ip: "8.8.8.8" })).asn).toBeNull();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await collector({ ...input(), ip: "8.8.8.8" })).asn).toBe(15169);
    expect(d.resolveTxt).toHaveBeenCalledTimes(2);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer a single origin ASN from ambiguous or malformed answers", async () => {
    const d = dependencies();
    for (const rows of [
      [["15169 3356 | prefix"]],
      [["15169 | prefix"], ["3356 | prefix"]],
      [["0 | prefix"]],
    ]) {
      const collector = createSignupRiskSignalCollector({
        ...d.lookups,
        resolveTxt: async () => rows,
      });
      expect((await collector({ ...input(), ip: "8.8.8.8" })).asn).toBeNull();
    }
  });
});
