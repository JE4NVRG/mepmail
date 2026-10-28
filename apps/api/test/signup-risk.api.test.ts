import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, generateApiKey, type Keyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import type { McpServer } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createClient } from "../../../packages/mcp/src/client.js";
import { registerTools } from "../../../packages/mcp/src/tools.js";
import { createApi } from "../src/app.js";
import { approveCampaignFixture, campaignDns } from "./approved-campaign-fixture.js";

let db: Db;
let close: () => Promise<void>;
const signals = {
  domain: "api-signup.example.test",
  disposable: false,
  mx: "present" as const,
  domainAgeDays: 500,
  catchAll: "unknown" as const,
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function fixture(isCloud = true) {
  const userId = randomUUID();
  const email = `${userId}@example.test`;
  const teamId = await createTeam(db, `api-signup-${userId}`);
  await approveCampaignFixture(db, teamId);
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Synthetic API principal", email, emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  await db
    .insert(schema.teamSignupRisk)
    .values({ teamId, principalUserId: userId, level: "sandbox", signals });
  const domain = `${userId}.example.test`;
  await db.insert(schema.domains).values({
    teamId,
    name: domain,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    ...campaignDns(domain),
  });
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "Synthetic FULL key",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
    permission: "full_access",
  });
  const real = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const wrap = vi.fn((dek: Buffer) => real.wrapDek(dek));
  const keyring: Keyring = {
    wrapDek: wrap,
    unwrapDek: (wrapped, version) => real.unwrapDek(wrapped, version),
  };
  const enqueue = vi.fn(async (_id: string) => {});
  const app = createApi({ db, keyring, isCloud, enqueueEmailSend: enqueue });
  const payload = {
    from: `Fixture <sender@${domain}>`,
    to: [email],
    subject: "Synthetic API test",
    text: "Synthetic content only",
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { app, teamId, email, token: key.token, payload, wrap, enqueue, post };
}

async function expectNoAcceptance(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.wrap).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(
    await db.select().from(schema.emails).where(eq(schema.emails.teamId, f.teamId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, f.teamId)),
  ).toHaveLength(0);
}

it("a full-access key can still send a sandbox test to its original verified address", async () => {
  const f = await fixture();
  const reply = await f.post("/emails", f.payload);
  expect(reply.status).toBe(200);
  expect(f.enqueue).toHaveBeenCalledOnce();
});

it.each(["cc", "bcc"] as const)("a full-access key cannot bypass external %s", async (field) => {
  const f = await fixture();
  const reply = await f.post("/emails", { ...f.payload, [field]: ["external@example.test"] });
  expect(reply.status).toBe(403);
  expect(await reply.json()).toMatchObject({ statusCode: 403, name: "signup_sandbox" });
  await expectNoAcceptance(f);
});

it("a full-access key cannot bypass review even for its principal's own address", async () => {
  const f = await fixture();
  await db
    .update(schema.teamSignupRisk)
    .set({ level: "hold" })
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  const reply = await f.post("/emails", f.payload);
  expect(reply.status).toBe(403);
  expect(await reply.json()).toMatchObject({ statusCode: 403, name: "signup_review_required" });
  await expectNoAcceptance(f);
});

it.each(["strict", "permissive"] as const)(
  "%s batch refuses the entire sandbox operation before encrypting its first allowed item",
  async (mode) => {
    const f = await fixture();
    const reply = await f.post(
      "/emails/batch",
      [f.payload, { ...f.payload, to: ["external@example.test"] }],
      { "x-batch-validation": mode },
    );
    expect(reply.status).toBe(403);
    expect(await reply.json()).toMatchObject({ statusCode: 403, name: "signup_sandbox" });
    await expectNoAcceptance(f);
  },
);

type Result = { content: { type: string; text: string }[]; isError?: boolean };

it.each(["send_email", "send_email_batch"] as const)(
  "%s preserves the underlying HTTP 403 across the local MCP boundary",
  async (name) => {
    const f = await fixture();
    const statuses: number[] = [];
    const callbacks = new Map<string, (args: unknown) => Promise<Result>>();
    registerTools(
      {
        registerTool: (
          tool: string,
          config: { inputSchema: { parse: (args: unknown) => unknown } },
          callback: (args: unknown) => Promise<Result>,
        ) => {
          callbacks.set(tool, (args) => callback(config.inputSchema.parse(args)));
        },
      } as unknown as McpServer,
      createClient({
        apiKey: f.token,
        baseUrl: "http://synthetic-mcp.example.test",
        fetchImpl: async (url, init) => {
          const response = await f.app.request(url, init);
          statuses.push(response.status);
          return response;
        },
      }),
    );
    const callback = callbacks.get(name);
    if (!callback) throw new Error("synthetic MCP tool not registered");
    const forbidden = { ...f.payload, bcc: ["external@example.test"] };
    const result = await callback(name === "send_email" ? forbidden : { emails: [forbidden] });
    expect(statuses).toEqual([403]);
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === "text");
    expect(JSON.parse(text?.text ?? "{}")).toMatchObject({
      untrusted_data: {
        statusCode: 403,
        name: "signup_sandbox",
      },
    });
    await expectNoAcceptance(f);
  },
);

it("self-host keeps its existing API behavior even with a synthetic cloud risk record", async () => {
  const f = await fixture(false);
  await db
    .update(schema.teamSignupRisk)
    .set({ level: "hold" })
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  const reply = await f.post("/emails", { ...f.payload, to: ["external@example.test"] });
  expect(reply.status).toBe(200);
  expect(f.enqueue).toHaveBeenCalledOnce();
});
