import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { DnsResolver, SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_TOKEN_URL } from "@/lib/cloudflare";
import {
  applyCloudflareRecords,
  type CloudflareDesiredRecord,
  txtText,
} from "@/server/cloudflare-dns";
import { createDomainsRouter, type DomainsSesDeps } from "@/server/routers/domains";
import { type Context, createCallerFactory, router } from "@/server/trpc";

const TOKEN = "cf_test_token_0123456789abcdefghijklmnopqrstuv";

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

/**
 * A small Cloudflare API: zones by exact name, DNS records by type and name,
 * create and patch. `fail` answers a given method+path prefix with an error.
 */
function fakeCloudflare(
  options: {
    zones?: string[];
    records?: FakeRecord[];
    fail?: { match: (method: string, path: string) => boolean; status: number; code: number };
  } = {},
) {
  const zones = (options.zones ?? ["example.com"]).map((name, i) => ({ id: `z${i}`, name }));
  const records = [...(options.records ?? [])];
  const calls: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    auth: string | undefined;
  }[] = [];
  let next = records.length;
  const reply = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      method,
      path,
      ...(body ? { body } : {}),
      auth: (init?.headers as Record<string, string>)?.authorization,
    });
    if (options.fail?.match(method, path))
      return reply(options.fail.status, {
        success: false,
        errors: [{ code: options.fail.code, message: "no" }],
      });
    if (path === "/zones")
      return reply(200, {
        success: true,
        result: zones.filter((zone) => zone.name === url.searchParams.get("name")),
      });
    const zoneRecords = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(path);
    if (zoneRecords && method === "GET")
      return reply(200, {
        success: true,
        result: records.filter(
          (r) => r.type === url.searchParams.get("type") && r.name === url.searchParams.get("name"),
        ),
      });
    if (zoneRecords && method === "POST") {
      const created = { id: `r${next++}`, ...(body as Omit<FakeRecord, "id">) };
      records.push(created);
      return reply(200, { success: true, result: created });
    }
    if (zoneRecords && method === "PATCH") {
      const target = records.find((r) => r.id === zoneRecords[2]);
      if (target) Object.assign(target, body);
      return reply(200, { success: true, result: target });
    }
    return reply(404, { success: false, errors: [{ code: 7003 }] });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, records };
}

const DKIM = '"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnewkey"';
const desired = (domain: string): CloudflareDesiredRecord[] => [
  { type: "TXT", name: `mepmail._domainkey.${domain}`, value: DKIM, policy: "own" },
  {
    type: "MX",
    name: `send.${domain}`,
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
    policy: "mailFromMx",
  },
  {
    type: "TXT",
    name: `send.${domain}`,
    value: '"v=spf1 include:amazonses.com ~all"',
    policy: "spf",
  },
  { type: "TXT", name: `_dmarc.${domain}`, value: '"v=DMARC1; p=none;"', policy: "createOnly" },
];

describe("applyCloudflareRecords", () => {
  it("finds the parent zone of a subdomain and creates every record, DNS only, automatic TTL", async () => {
    const cf = fakeCloudflare();
    const result = await applyCloudflareRecords(
      {
        token: TOKEN,
        domain: "mail.example.com",
        apex: "example.com",
        records: desired("mail.example.com"),
      },
      { fetch: cf.fetch },
    );
    expect(result).toEqual({
      ok: true,
      zone: "example.com",
      records: [
        { type: "TXT", name: "mepmail._domainkey.mail.example.com", outcome: "created" },
        { type: "MX", name: "send.mail.example.com", outcome: "created" },
        { type: "TXT", name: "send.mail.example.com", outcome: "created" },
        { type: "TXT", name: "_dmarc.mail.example.com", outcome: "created" },
      ],
    });
    // mail.example.com is not a zone of its own: the search walks up.
    expect(cf.calls.filter((c) => c.path === "/zones")).toHaveLength(2);
    const mx = cf.calls.find((c) => c.method === "POST" && c.body?.type === "MX");
    expect(mx?.body).toMatchObject({ priority: 10, ttl: 1, comment: "MepMail" });
    const dkim = cf.calls.find(
      (c) => c.method === "POST" && c.body?.name === "mepmail._domainkey.mail.example.com",
    );
    expect(dkim?.body?.content).toBe(DKIM);
    expect(cf.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    // The token never comes back in the answer.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("leaves matching records alone, split TXT strings and trailing dots included", async () => {
    const cf = fakeCloudflare({
      records: [
        {
          id: "a",
          type: "TXT",
          name: "mepmail._domainkey.example.com",
          content: '"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMII" "BCgKCAQEAnewkey"',
        },
        {
          id: "b",
          type: "MX",
          name: "send.example.com",
          content: "feedback-smtp.us-east-1.amazonses.com.",
          priority: 10,
        },
        {
          id: "c",
          type: "TXT",
          name: "send.example.com",
          content: "v=spf1 include:amazonses.com ~all",
        },
      ],
    });
    const result = await applyCloudflareRecords(
      {
        token: TOKEN,
        domain: "example.com",
        apex: "example.com",
        records: desired("example.com").slice(0, 3),
      },
      { fetch: cf.fetch },
    );
    expect(result.ok && result.records.map((r) => r.outcome)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("replaces only what is ours and keeps everything else, reporting it", async () => {
    const cf = fakeCloudflare({
      records: [
        // An older DKIM key from a previous add of this domain: ours to replace.
        {
          id: "a",
          type: "TXT",
          name: "mepmail._domainkey.example.com",
          content: '"v=DKIM1; k=rsa; p=oldkey"',
        },
        // MAIL FROM from another SES region: replaced.
        {
          id: "b",
          type: "MX",
          name: "send.example.com",
          content: "feedback-smtp.eu-west-1.amazonses.com",
          priority: 10,
        },
        // Someone else's SPF on that name: a second one would break both.
        {
          id: "c",
          type: "TXT",
          name: "send.example.com",
          content: '"v=spf1 include:_spf.google.com ~all"',
        },
        // A DMARC already there is the person's policy.
        { id: "d", type: "TXT", name: "_dmarc.example.com", content: '"v=DMARC1; p=reject"' },
      ],
    });
    const result = await applyCloudflareRecords(
      { token: TOKEN, domain: "example.com", apex: "example.com", records: desired("example.com") },
      { fetch: cf.fetch },
    );
    expect(result.ok && result.records.map((r) => r.outcome)).toEqual([
      "updated",
      "updated",
      "conflict",
      "conflict",
    ]);
    expect(cf.calls.filter((c) => c.method === "PATCH").map((c) => c.path)).toEqual([
      "/zones/z0/dns_records/a",
      "/zones/z0/dns_records/b",
    ]);
    expect(cf.records.find((r) => r.id === "c")?.content).toContain("google");
    expect(cf.records.find((r) => r.id === "d")?.content).toContain("reject");
  });

  it("never replaces an MX on the MAIL FROM host that points somewhere other than SES", async () => {
    const cf = fakeCloudflare({
      records: [
        { id: "m", type: "MX", name: "send.example.com", content: "mx.other.example", priority: 5 },
      ],
    });
    const result = await applyCloudflareRecords(
      {
        token: TOKEN,
        domain: "example.com",
        apex: "example.com",
        records: [desired("example.com")[1] as CloudflareDesiredRecord],
      },
      { fetch: cf.fetch },
    );
    expect(result.ok && result.records[0]?.outcome).toBe("conflict");
    expect(cf.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it.each([
    ["an unknown token", 403, 10000, "rejected"],
    ["an invalid header", 400, 6003, "rejected"],
    ["a 401", 401, 0, "rejected"],
    ["a token without the zone", 403, 9109, "forbidden"],
  ] as const)("maps %s on the zone search to %s", async (_label, status, code, reason) => {
    const cf = fakeCloudflare({ fail: { match: (_m, path) => path === "/zones", status, code } });
    expect(
      await applyCloudflareRecords(
        {
          token: TOKEN,
          domain: "example.com",
          apex: "example.com",
          records: desired("example.com"),
        },
        { fetch: cf.fetch },
      ),
    ).toEqual({ ok: false, reason });
  });

  it("stops at the first write the token may not make", async () => {
    const cf = fakeCloudflare({ fail: { match: (m) => m === "POST", status: 403, code: 9109 } });
    expect(
      await applyCloudflareRecords(
        {
          token: TOKEN,
          domain: "example.com",
          apex: "example.com",
          records: desired("example.com"),
        },
        { fetch: cf.fetch },
      ),
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(cf.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("fails one record, not the run, on an unexpected answer", async () => {
    const cf = fakeCloudflare();
    let first = true;
    const flaky: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST" && first) {
        first = false;
        return new Response("oops", { status: 502 });
      }
      return cf.fetch(input, init);
    };
    const result = await applyCloudflareRecords(
      { token: TOKEN, domain: "example.com", apex: "example.com", records: desired("example.com") },
      { fetch: flaky },
    );
    expect(result.ok && result.records.map((r) => r.outcome)).toEqual([
      "failed",
      "created",
      "created",
      "created",
    ]);
  });

  it("reports a zone the token cannot see, a malformed token and a network failure", async () => {
    const cf = fakeCloudflare({ zones: ["other.com"] });
    expect(
      await applyCloudflareRecords(
        {
          token: TOKEN,
          domain: "example.com",
          apex: "example.com",
          records: desired("example.com"),
        },
        { fetch: cf.fetch },
      ),
    ).toEqual({ ok: false, reason: "zone_not_found" });

    const unused = vi.fn();
    expect(
      await applyCloudflareRecords(
        { token: "short", domain: "example.com", apex: "example.com", records: [] },
        { fetch: unused as unknown as typeof fetch },
      ),
    ).toEqual({ ok: false, reason: "rejected" });
    expect(unused).not.toHaveBeenCalled();

    expect(
      await applyCloudflareRecords(
        {
          token: TOKEN,
          domain: "example.com",
          apex: "example.com",
          records: desired("example.com"),
        },
        { fetch: async () => Promise.reject(new TypeError("fetch failed")) },
      ),
    ).toEqual({ ok: false, reason: "unreachable" });
  });

  it("joins split TXT character strings and drops their quotes", () => {
    expect(txtText('"v=DKIM1; p=ab" "cd"')).toBe("v=DKIM1; p=abcd");
    expect(txtText("v=spf1 ~all")).toBe("v=spf1 ~all");
  });

  it("links to token creation with Zone: Read and DNS: Edit pre-filled", () => {
    const url = new URL(CLOUDFLARE_TOKEN_URL);
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]")).toEqual([
      { key: "zone", type: "read" },
      { key: "dns", type: "edit" },
    ]);
  });
});

describe("domains.cloudflareSetup", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    vi.stubEnv("AWS_REGION", "us-east-1");
  });
  afterEach(async () => {
    await close();
    vi.unstubAllEnvs();
  });

  const ses: SesIdentityClient = {
    async send(command) {
      if (command.constructor.name === "GetEmailIdentityCommand")
        return {
          VerifiedForSendingStatus: false,
          DkimAttributes: { Status: "PENDING" },
          MailFromAttributes: { MailFromDomainStatus: "PENDING" },
        };
      return {};
    },
  };
  const dns = (dmarc: string[][]): DnsResolver => ({
    resolveTxt: async (name) => (name.startsWith("_dmarc.") ? dmarc : []),
    resolveMx: async () => [],
    resolveCname: async () => [],
  });
  const caller = (teamId: string, deps: DomainsSesDeps, role: Context["role"] = "owner") =>
    createCallerFactory(router({ domains: createDomainsRouter(deps) }))({
      db,
      session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
      teamId,
      role,
    });

  it("writes the domain's records, skips DMARC when the person has one, checks DNS and audits", async () => {
    const teamId = await createTeam(db);
    const cf = fakeCloudflare();
    const deps: DomainsSesDeps = {
      clientForRegion: () => ses,
      resolveNs: async () => ["ada.ns.cloudflare.com"],
      dns: dns([["v=DMARC1; p=quarantine"]]),
      cloudflareFetch: cf.fetch,
    };
    const api = caller(teamId, deps);
    const { id } = await api.domains.create({ name: "example.com", region: "us-east-1" });
    const result = await api.domains.cloudflareSetup({ id, token: TOKEN });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records.map((r) => [r.type, r.name, r.outcome])).toEqual([
      ["TXT", "mepmail._domainkey.example.com", "created"],
      ["MX", "send.example.com", "created"],
      ["TXT", "send.example.com", "created"],
    ]);
    const [stored] = await db
      .select({ key: schema.domains.dkimPublicKey })
      .from(schema.domains)
      .where(eq(schema.domains.id, id));
    expect(String(cf.records[0]?.content)).toContain(String(stored?.key));
    expect(result.check.status).toBe("pending");
    const audits = await db
      .select({ action: schema.auditLog.action, data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, teamId));
    expect(audits).toContainEqual({
      action: "domain.dns_configured",
      data: expect.objectContaining({ name: "example.com", provider: "cloudflare", written: 3 }),
    });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it("creates DMARC only where none applies and refuses members", async () => {
    const teamId = await createTeam(db);
    const cf = fakeCloudflare();
    const deps: DomainsSesDeps = {
      clientForRegion: () => ses,
      resolveNs: async () => [],
      dns: dns([]),
      cloudflareFetch: cf.fetch,
    };
    const { id } = await caller(teamId, deps).domains.create({
      name: "example.com",
      region: "us-east-1",
    });
    await expect(
      caller(teamId, deps, "member").domains.cloudflareSetup({ id, token: TOKEN }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await caller(teamId, deps).domains.cloudflareSetup({ id, token: TOKEN });
    expect(result.ok && result.records.at(-1)).toEqual({
      type: "TXT",
      name: "_dmarc.example.com",
      outcome: "created",
    });
  });
});
