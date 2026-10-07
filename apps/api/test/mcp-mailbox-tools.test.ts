import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import {
  deriveInternalActorKey,
  EnvKeyring,
  INTERNAL_ACTOR_HEADER,
  mcpResourceUrl,
  verifyInternalActor,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let closeDb: () => Promise<void>;
let jwks: ServerType;
let web: ServerType;
let resource: string;
let appBaseUrl: string;
let app: ReturnType<typeof createApi>;
let teamId: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const userId = "mcp-mailbox-user";
const actorKey = deriveInternalActorKey(randomBytes(32));
const calls: { actor: unknown; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "mcp-mailboxes");
  await db.insert(schema.user).values({ id: userId, name: "Owner", email: "owner@acme.dev" });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });

  const keys = await generateKeyPair("EdDSA");
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "EdDSA" };
  const listen = (fetch: (r: Request) => Response | Promise<Response>) =>
    new Promise<{ server: ServerType; origin: string }>((resolve) => {
      const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
        resolve({ server, origin: `http://127.0.0.1:${info.port}` }),
      );
    });
  const auth = await listen(new Hono().get("/api/auth/jwks", (c) => c.json({ keys: [jwk] })).fetch);
  jwks = auth.server;
  appBaseUrl = auth.origin;
  resource = mcpResourceUrl(appBaseUrl);
  // Stands in for the dashboard's internal mailbox admin endpoint.
  const dashboard = await listen(
    new Hono().post("/api/internal/mailbox-admin", async (c) => {
      const body = await c.req.json();
      calls.push({
        actor: verifyInternalActor(actorKey, c.req.header(INTERNAL_ACTOR_HEADER)),
        body,
      });
      if (body.action === "list") return c.json({ can_manage: true, mailboxes: [] });
      if (body.action === "create") return c.json({ error: "service", code: "quota" }, 409);
      return c.json({ id: "k1", token: "mmb_secret", scopes: body.scopes });
    }).fetch,
  );
  web = dashboard.server;
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    appBaseUrl,
    enqueueEmailSend: async () => {},
    mailboxAgentOrigin: dashboard.origin,
    internalActorKey: actorKey,
  });
});
afterAll(async () => {
  jwks.close();
  web.close();
  await closeDb();
});

async function connect(scope: string, role = "owner"): Promise<Client> {
  const token = await new SignJWT({ scope, client_id: "c", team_id: teamId, team_role: role })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key", typ: "at+jwt" })
    .setIssuer(appBaseUrl)
    .setAudience(resource)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(privateKey);
  const client = new Client({ name: "mailbox-tools", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      fetch: async (url, init) => app.request(url, init),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const data = (result: { content?: unknown }) =>
  JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}").untrusted_data;

it("offers the mailbox tools only for the mailbox scopes", async () => {
  const reader = await connect("mailboxes:read");
  expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(["list_mailboxes"]);
  await reader.close();
  const none = await connect("emails:read");
  expect((await none.listTools()).tools.map((t) => t.name)).not.toContain("list_mailboxes");
  await none.close();
});

it("calls the dashboard as the signed-in user and relays its answers", async () => {
  const client = await connect("mailboxes:read mailboxes:write");
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    "create_mailbox",
    "create_mailbox_agent_key",
    "list_mailboxes",
  ]);
  expect(data(await client.callTool({ name: "list_mailboxes", arguments: {} }))).toEqual({
    can_manage: true,
    mailboxes: [],
  });
  const refused = await client.callTool({
    name: "create_mailbox",
    arguments: {
      domain_id: "00000000-0000-4000-8000-000000000001",
      local_part: "suporte",
      label: "Suporte",
    },
  });
  expect(refused.isError).toBe(true);
  expect(data(refused)).toEqual({ error: "service", code: "quota" });
  const key = await client.callTool({
    name: "create_mailbox_agent_key",
    arguments: { mailbox_id: "00000000-0000-4000-8000-000000000002", label: "Sage" },
  });
  expect(data(key)).toMatchObject({ id: "k1", scopes: ["read", "draft"] });
  // The schema itself refuses the send permission.
  const send = await client.callTool({
    name: "create_mailbox_agent_key",
    arguments: {
      mailbox_id: "00000000-0000-4000-8000-000000000002",
      label: "Sage",
      scopes: ["send"],
    },
  });
  expect(send.isError).toBe(true);
  expect(calls.map((c) => c.body.action)).toEqual(["list", "create", "create_agent_key"]);
  for (const call of calls) expect(call.actor).toMatchObject({ teamId, userId });
  expect(calls[1]?.body).toEqual({
    action: "create",
    domainId: "00000000-0000-4000-8000-000000000001",
    localPart: "suporte",
    label: "Suporte",
    kind: "agent",
  });
  await client.close();
});

it("keeps the write tools from a member", async () => {
  await db
    .update(schema.teamMembers)
    .set({ role: "member" })
    .where(eq(schema.teamMembers.userId, userId));
  const client = await connect("mailboxes:read mailboxes:write", "member");
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("list_mailboxes");
  expect(names).not.toContain("create_mailbox");
  await client.close();
});
