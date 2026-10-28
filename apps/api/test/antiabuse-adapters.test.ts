import { randomBytes, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { EnvKeyring, generateApiKey, MCP_SCOPES, mcpResourceUrl } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../../../packages/core/src/campaign-consent.js";
import { createClient } from "../../../packages/mcp/src/client.js";
import { registerTools } from "../../../packages/mcp/src/tools.js";
import { createApi } from "../src/app.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const promo = "Course Spotlight. Limited seats. Register for London training.";
beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => {
  await fixture?.close();
});
async function setup(isCloud = true) {
  const { db } = fixture;
  const teamId = await createTeam(db, randomUUID());
  await db
    .update(schema.teams)
    .set({ createdAt: new Date(Date.now() - 40 * 86400000), sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  const domain = `${randomUUID()}.example.test`;
  await db
    .insert(schema.domains)
    .values({
      teamId,
      name: domain,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
  const key = generateApiKey();
  await db
    .insert(schema.apiKeys)
    .values({
      teamId,
      name: "synthetic",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
  const enqueued: string[] = [];
  const app = createApi({
    db,
    keyring,
    isCloud,
    enqueueEmailSend: async (id) => {
      enqueued.push(id);
    },
  });
  const call = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const message = {
    from: `service@${domain}`,
    to: ["recipient@example.test"],
    subject: "Message",
    text: promo,
    isCloud: false,
  };
  return { db, teamId, token: key.token, app, call, message, enqueued };
}
async function counts(teamId: string) {
  const { db } = fixture;
  return {
    emails: await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    usage: await db
      .select()
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, teamId)),
    contacts: await db.select().from(schema.contacts).where(eq(schema.contacts.teamId, teamId)),
  };
}
it.each(["/emails", "/emails/batch"])(
  "cloud %s maps consent rejection to 403 and ignores client isCloud:false",
  async (path) => {
    const f = await setup();
    const response = await f.call(path, path.endsWith("batch") ? [f.message] : f.message);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      name: "campaign_consent_required",
      statusCode: 403,
    });
    expect(await counts(f.teamId)).toEqual({ emails: [], usage: [], contacts: [] });
    expect(f.enqueued).toEqual([]);
  },
);
it("cloud contact import is authenticated but refused; client deployment flag is not authority", async () => {
  const f = await setup();
  expect((await f.call("/contacts")).status).toBe(200);
  const response = await f.call("/contacts/batch", [
    { email: "synthetic@example.test", isCloud: false },
  ]);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ name: "campaign_consent_required" });
  expect((await counts(f.teamId)).contacts).toEqual([]);
});
it("a consent refusal after the first deferred item rolls the entire batch back", async () => {
  const f = await setup();
  const response = await f.call("/emails/batch", [
    { ...f.message, text: "You requested a password reset." },
    f.message,
  ]);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ name: "campaign_consent_required" });
  expect(await counts(f.teamId)).toEqual({ emails: [], usage: [], contacts: [] });
  expect(f.enqueued).toEqual([]);
});
it.each(["campaign_manual_review_required", "campaign_domain_required", "team_restricted"])(
  "single/batch/import preserve the actual consent refusal %s",
  async (reason) => {
    const f = await setup();
    const dossier = await submitCampaignConsent(f.db, {
      teamId: f.teamId,
      actorId: "synthetic-owner",
      evidence: {
        listReference: "synthetic-list-42",
        source: "First party public registration form",
        method: "Explicit unchecked consent checkbox",
        formUrl: "https://example.test/signup",
        permissionText: "I agree to receive Example training offers.",
        permissionScope: "Example training and course invitations",
        samples: [
          { reference: "record-42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
        ],
      },
    });
    await reviewCampaignConsent(f.db, {
      teamId: f.teamId,
      dossierId: dossier.id,
      operatorId: "synthetic-operator",
      decision: "approved",
      reason: "Synthetic first party evidence reviewed",
    });
    if (reason === "campaign_manual_review_required")
      await f.db
        .update(schema.teams)
        .set({ sendReviewClearedAt: null })
        .where(eq(schema.teams.id, f.teamId));
    if (reason === "team_restricted")
      await f.db
        .update(schema.teams)
        .set({ broadcastsPausedByOperatorAt: new Date() })
        .where(eq(schema.teams.id, f.teamId));
    for (const [path, body] of [
      ["/emails", f.message],
      ["/emails/batch", [f.message]],
      ["/contacts/batch", [{ email: "blocked@example.test" }]],
    ] as const) {
      const response = await f.call(path, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ name: reason, statusCode: 403 });
    }
    expect(await counts(f.teamId)).toEqual({ emails: [], usage: [], contacts: [] });
    expect(f.enqueued).toEqual([]);
  },
);
it("batch reserves the effective probation ceiling once: 25 queued, five parked, never 30 charged", async () => {
  const f = await setup();
  const messages = Array.from({ length: 30 }, (_, i) => ({
    ...f.message,
    subject: `Receipt ${i}`,
    text: "You requested a password reset.",
  }));
  const response = await f.call("/emails/batch", messages);
  expect(response.status).toBe(200);
  const state = await counts(f.teamId);
  expect(state.emails).toHaveLength(30);
  expect(state.emails.filter((row) => row.latestStatus === "queued")).toHaveLength(25);
  expect(state.emails.filter((row) => row.latestStatus === "queued_quota")).toHaveLength(5);
  expect(state.usage).toHaveLength(1);
  expect(state.usage[0]?.accepted).toBe(25);
  expect(f.enqueued).toHaveLength(25);
  expect(new Set(f.enqueued).size).toBe(25);
});
it("server-owned selfhost:false preserves contact import and campaign single/batch sends", async () => {
  const f = await setup(false);
  expect((await f.call("/contacts/batch", [{ email: "selfhost@example.test" }])).status).toBe(200);
  expect((await f.call("/emails", f.message)).status).toBe(200);
  expect((await f.call("/emails/batch", [f.message])).status).toBe(200);
  const state = await counts(f.teamId);
  expect(state.contacts).toHaveLength(1);
  expect(state.emails).toHaveLength(2);
  expect(f.enqueued).toHaveLength(2);
});
async function listen(app: { fetch: (request: Request) => Response | Promise<Response> }) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fixture listener missing");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
function data(result: { content?: unknown }) {
  const content = result.content as { type: string; text?: string }[];
  return JSON.parse(content.find((item) => item.type === "text")?.text ?? "null").untrusted_data;
}
it.each([true, false])(
  "local MCP real tools/call with valid API key delegates to HTTP routes (cloud=%s)",
  async (isCloud) => {
    const f = await setup(isCloud);
    const api = await listen(f.app);
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "antiabuse-synthetic", version: "1" });
      registerTools(server, createClient({ apiKey: f.token, baseUrl: api.origin }));
      return server;
    });
    const mcp = await listen(new Hono().all("/mcp", (c) => handler.fetch(c.req.raw)));
    const client = new Client({ name: "synthetic", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${mcp.origin}/mcp`)));
      const read = await client.callTool({ name: "list_contacts", arguments: {} });
      expect(read.isError).not.toBe(true);
      const result = await client.callTool({
        name: "create_contact",
        arguments: { email: "mcp@example.test" },
      });
      expect(result.isError === true).toBe(isCloud);
      if (isCloud)
        expect(data(result)).toMatchObject({ name: "campaign_consent_required", statusCode: 403 });
      expect((await counts(f.teamId)).contacts).toHaveLength(isCloud ? 0 : 1);
    } finally {
      await client.close();
      await mcp.close();
      await api.close();
    }
  },
);
it("hosted MCP real tools/call create/import traverse protected HTTP handlers, not global auth403", async () => {
  const f = await setup();
  const userId = randomUUID();
  await f.db
    .insert(schema.user)
    .values({ id: userId, name: "Synthetic", email: `${userId}@example.test` });
  await f.db.insert(schema.teamMembers).values({ teamId: f.teamId, userId, role: "admin" });
  const keys = await generateKeyPair("EdDSA");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "EdDSA" };
  const jwks = await listen(new Hono().get("/api/auth/jwks", (c) => c.json({ keys: [jwk] })));
  const app = createApi({
    db: f.db,
    keyring,
    isCloud: true,
    appBaseUrl: jwks.origin,
    enqueueEmailSend: async (id) => {
      f.enqueued.push(id);
    },
  });
  const resource = mcpResourceUrl(jwks.origin);
  const token = await new SignJWT({
    scope: MCP_SCOPES.join(" "),
    client_id: "fixture",
    team_id: f.teamId,
    team_role: "admin",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "fixture", typ: "at+jwt" })
    .setIssuer(jwks.origin)
    .setAudience(resource)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const client = new Client({ name: "synthetic", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        fetch: async (url, init) => app.request(url, init),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    expect((await client.callTool({ name: "list_contacts", arguments: {} })).isError).not.toBe(
      true,
    );
    for (const [name, args] of [
      ["create_contact", { email: "hosted@example.test" }],
      ["create_contact_batch", { contacts: [{ email: "import@example.test" }] }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(data(result)).toMatchObject({ name: "campaign_consent_required", statusCode: 403 });
    }
    expect((await counts(f.teamId)).contacts).toHaveLength(0);
    expect(f.enqueued).toEqual([]);
  } finally {
    await client.close();
    await jwks.close();
  }
});
