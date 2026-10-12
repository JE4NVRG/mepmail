import { randomBytes } from "node:crypto";
import { type ServerType, serve } from "@hono/node-server";
import { z } from "@hono/zod-openapi";
import { deriveInternalActorKey, EnvKeyring, mcpResourceUrl } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCorreioTools } from "../../../packages/mcp/src/correio.js";
import {
  CORREIO_TOOL_NAMES,
  CORREIO_TOOLS_VERSION,
} from "../../../packages/mcp/src/correio-tools.js";
import { createApi } from "../src/app.js";

/**
 * The Correio tools are one contract served three ways: the npm package (stdio,
 * agent key), the hosted /mcp/correio (agent key) and the hosted OAuth /mcp (mail
 * scopes). This asserts what each one actually lists: the same tools in the same
 * order, the same arguments (only the npm package adds its local-file options), and
 * the same tools_version, so a deployment that lags is visible.
 */
let db: Db;
let closeDb: () => Promise<void>;
let jwks: ServerType;
let web: ServerType;
let resource: string;
let appBaseUrl: string;
let app: ReturnType<typeof createApi>;
let teamId: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const userId = "parity-user";
const KEY = `mmb_00000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "correio-parity");
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
  const dashboard = await listen(
    new Hono().all("/api/mailbox-agent/*", (c) =>
      c.json({ credential: "team", mailboxes: [{ address: "a@acme.dev", scopes: ["read"] }] }),
    ).fetch,
  );
  web = dashboard.server;
  app = createApi({
    db,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: true,
    appBaseUrl,
    enqueueEmailSend: async () => {},
    mailboxAgentOrigin: dashboard.origin,
    internalActorKey: deriveInternalActorKey(randomBytes(32)),
  });
});
afterAll(async () => {
  jwks.close();
  web.close();
  await closeDb();
});

interface Listed {
  name: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] };
}
async function hosted(path: "/mcp" | "/mcp/correio"): Promise<{ tools: Listed[]; client: Client }> {
  const url = path === "/mcp" ? new URL(resource) : new URL("http://api.test/mcp/correio");
  const token =
    path === "/mcp"
      ? await new SignJWT({
          scope: "mail:read mail:draft",
          client_id: "c",
          team_id: teamId,
          team_role: "owner",
        })
          .setProtectedHeader({ alg: "EdDSA", kid: "test-key", typ: "at+jwt" })
          .setIssuer(appBaseUrl)
          .setAudience(resource)
          .setSubject(userId)
          .setIssuedAt()
          .setExpirationTime("15m")
          .sign(privateKey)
      : KEY;
  const client = new Client({ name: "parity", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      fetch: async (u, init) => app.request(u, init),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return { tools: (await client.listTools()).tools as Listed[], client };
}
/** The npm package's registrations, as JSON Schema like a tools/list answer. */
function npmTools(): Listed[] {
  const tools: Listed[] = [];
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodType }) =>
      tools.push({
        name,
        inputSchema: z.toJSONSchema(config.inputSchema, { io: "input" }) as Listed["inputSchema"],
      }),
  } as unknown as McpServer;
  registerCorreioTools(server, { token: KEY, origin: "https://mepmail.dev" });
  return tools;
}
const keys = (tool: Listed | undefined) => Object.keys(tool?.inputSchema.properties ?? {}).sort();
const required = (tool: Listed | undefined) => [...(tool?.inputSchema.required ?? [])].sort();
/** What only the local package offers: reading/saving files on the agent's own disk. */
const NPM_ONLY: Record<string, string[]> = { mailbox_get_attachment: ["inline"] };

describe("Correio tool parity across npm, /mcp/correio and /mcp", () => {
  it("lists the same tools, in the same order, with the same arguments", async () => {
    const oauth = await hosted("/mcp");
    const correio = await hosted("/mcp/correio");
    const npm = npmTools();
    const mailNames = oauth.tools.map((t) => t.name).filter((n) => n.startsWith("mailbox_"));
    expect(mailNames).toEqual([...CORREIO_TOOL_NAMES]);
    expect(correio.tools.map((t) => t.name)).toEqual([...CORREIO_TOOL_NAMES]);
    expect(npm.map((t) => t.name)).toEqual([...CORREIO_TOOL_NAMES]);
    for (const name of CORREIO_TOOL_NAMES) {
      const a = oauth.tools.find((t) => t.name === name);
      const b = correio.tools.find((t) => t.name === name);
      const c = npm.find((t) => t.name === name);
      expect(keys(a), `${name} on /mcp vs /mcp/correio`).toEqual(keys(b));
      expect(required(a), `${name} required`).toEqual(required(b));
      expect(
        keys(c).filter((k) => !(NPM_ONLY[name] ?? []).includes(k)),
        `${name} on npm`,
      ).toEqual(keys(b));
      expect(required(c), `${name} required on npm`).toEqual(required(b));
    }
    // The 0.3.0 arguments are on every surface.
    const list = correio.tools.find((t) => t.name === "mailbox_list_messages");
    expect(keys(list)).toEqual(
      [
        "after",
        "before",
        "cursor",
        "folder",
        "from",
        "limit",
        "mailbox",
        "query",
        "subject",
        "unread",
      ].sort(),
    );
    expect(keys(oauth.tools.find((t) => t.name === "mailbox_save_draft"))).toEqual(
      expect.arrayContaining(["attachments", "keep_attachments"]),
    );
    await oauth.client.close();
    await correio.client.close();
  });

  it("names its surface and the tool set version, the same on every deployment", async () => {
    for (const [path, surface] of [
      ["/mcp", "hosted-oauth"],
      ["/mcp/correio", "hosted-correio"],
    ] as const) {
      const { client } = await hosted(path);
      const result = await client.callTool({ name: "mailbox_list_accounts", arguments: {} });
      const data = JSON.parse((result.content as { text: string }[])[0]!.text).untrusted_data;
      expect(data.server).toEqual({ surface, tools_version: CORREIO_TOOLS_VERSION });
      await client.close();
    }
  });
});
