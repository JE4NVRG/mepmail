import { request, type Server } from "node:http";
import type { Socket } from "node:net";
import { serve } from "@hono/node-server";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import {
  type AuthInfo,
  bearerAuthChallengeResponse,
  createMcpHandler,
  McpServer,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { describe, expect, it } from "vitest";
import { normalizeMcpResponseConnection } from "../src/mcp-response.js";

const PROTOCOL = "2025-11-25";
const FIXTURE_TOKEN = "mcp-http-synthetic-token";
const FIXTURE_USAGE = { teamId: "mcp-http-fixture-team", sent: 0, limit: 3000 };

interface HttpReply {
  status: number;
  connection: string | undefined;
  contentType: string | undefined;
  body: string;
}

/** Default Node agent + explicit close reproduces urllib/Nginx HTTP/1.1. */
function post(
  origin: string,
  value: Record<string, unknown>,
  sockets: Set<Socket>,
  protocol?: string,
): Promise<HttpReply> {
  const body = JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}/mcp`,
      {
        method: "POST",
        // No agent override: the regression needs the normal shared agent.
        headers: {
          authorization: `Bearer ${FIXTURE_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": "MepMail-own-usage-proof/1",
          "content-length": Buffer.byteLength(body),
          connection: "close",
          ...(protocol ? { "mcp-protocol-version": protocol } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) res.destroy(new Error("fixture response too large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            connection: res.headers.connection,
            contentType: res.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("socket", (socket) => sockets.add(socket));
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("fixture request timeout")));
    req.end(body);
  });
}

function rpc(reply: HttpReply, id: number): Record<string, unknown> {
  expect(reply.status).toBe(200);
  const payload = reply.contentType?.startsWith("text/event-stream")
    ? reply.body
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
    : reply.body;
  expect(payload).toBeTruthy();
  const message = JSON.parse(payload ?? "") as {
    jsonrpc: string;
    id: number;
    result: Record<string, unknown>;
    error?: unknown;
  };
  expect(message.jsonrpc).toBe("2.0");
  expect(message.id).toBe(id);
  expect(message.error).toBeUndefined();
  return message.result;
}

async function fixture(normalize: boolean) {
  const sockets = new Set<Socket>();
  const mcpErrors: string[] = [];
  let factories = 0;
  let usageCalls = 0;
  const authInfo: AuthInfo = {
    token: FIXTURE_TOKEN,
    clientId: "mcp-http-fixture-client",
    scopes: ["emails:read"],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    resource: new URL("https://api-mepmail.je4ndev.com/mcp"),
    extra: {
      auth: {
        teamId: FIXTURE_USAGE.teamId,
        plan: "free",
        billing: { plan: "free", currentPeriodEnd: null },
        apiKeyId: null,
        userId: "mcp-http-fixture-user",
        oauthClientId: "mcp-http-fixture-client",
        permission: "full_access",
        domainId: null,
      },
      userId: "mcp-http-fixture-user",
      role: "owner",
    },
  };
  const bearer = {
    verifier: {
      async verifyAccessToken(token: string) {
        if (token !== FIXTURE_TOKEN) throw new Error("fixture token mismatch");
        return authInfo;
      },
    },
    resourceMetadataUrl: "https://api-mepmail.je4ndev.com/.well-known/oauth-protected-resource/mcp",
  };
  const handler = createMcpHandler(
    ({ authInfo: received }) => {
      expect(received).toBe(authInfo);
      factories++;
      const server = new McpServer({ name: "mcp-http-fixture", version: "1" });
      server.registerTool(
        "get_usage",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => {
          usageCalls++;
          return {
            content: [{ type: "text", text: JSON.stringify(FIXTURE_USAGE) }],
            structuredContent: FIXTURE_USAGE,
          };
        },
      );
      return server;
    },
    { onerror: (error) => mcpErrors.push(error.name) },
  );
  const app = new OpenAPIHono();
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["retry-after"],
      maxAge: 86400,
    }),
  );
  app.use(
    "*",
    bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: "too_large" }, 413) }),
  );
  app.use("*", secureHeaders());
  app.all("/mcp", async (c) => {
    let verified: AuthInfo;
    try {
      verified = await verifyBearerToken(c.req.header("authorization"), bearer);
    } catch (error) {
      return bearerAuthChallengeResponse(error, bearer);
    }
    const response = await handler.fetch(c.req.raw, { authInfo: verified });
    return normalize ? normalizeMcpResponseConnection(response) : response;
  });
  let server: Server | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () =>
        resolve(),
      ) as Server;
    });
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("fixture address unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    return {
      post: (value: Record<string, unknown>, protocol?: string) =>
        post(origin, value, sockets, protocol),
      state: () => ({ factories, usageCalls, mcpErrors }),
      async close() {
        await handler.close();
        const stopped = new Promise<void>((resolve, reject) => {
          server?.close((error) => (error ? reject(error) : resolve()));
        });
        // Close only this fixture's clients/server; never destroy the global agent.
        for (const socket of sockets) socket.destroy();
        server?.closeAllConnections();
        await stopped;
      },
    };
  } catch (error) {
    await handler.close();
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    server?.close();
    throw error;
  }
}

const initialize = {
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "mepmail-own-usage-proof", version: "1" },
  },
  id: 1,
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("MCP HTTP connection framing", () => {
  it("reproduces the upstream keep-alive conflict before response normalization", async () => {
    const via = await fixture(false);
    try {
      const first = await via.post(initialize);
      expect(rpc(first, 1).protocolVersion).toBe(PROTOCOL);
      expect(first.connection).toBe("keep-alive");
      const notification = await via.post(initialized, PROTOCOL);
      expect(notification.status).toBe(400);
      expect(notification.body).toBe("");
      expect(notification.contentType).toBeUndefined();
      expect(via.state()).toEqual({ factories: 1, usageCalls: 0, mcpErrors: [] });
    } finally {
      await via.close();
    }
  });

  it("completes initialization, listing and one synthetic read-only call with the real helper", async () => {
    const via = await fixture(true);
    try {
      const first = await via.post(initialize);
      expect(rpc(first, 1).protocolVersion).toBe(PROTOCOL);
      expect(first.connection).toBe("close");
      const notification = await via.post(initialized, PROTOCOL);
      expect(notification.status).toBe(202);
      expect(notification.body).toBe("");
      const listing = rpc(
        await via.post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 }, PROTOCOL),
        2,
      );
      expect(listing.tools).toMatchObject([
        { name: "get_usage", annotations: { readOnlyHint: true } },
      ]);
      const usage = rpc(
        await via.post(
          {
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "get_usage", arguments: {} },
            id: 3,
          },
          PROTOCOL,
        ),
        3,
      );
      expect(usage.structuredContent).toEqual(FIXTURE_USAGE);
      expect(usage.isError).not.toBe(true);
      expect(via.state()).toEqual({ factories: 4, usageCalls: 1, mcpErrors: [] });
    } finally {
      await via.close();
    }
  });

  it("preserves the response status, payload and MCP headers", async () => {
    const response = new Response("fixture-payload", {
      status: 207,
      headers: { connection: "keep-alive", "mcp-session-id": "fixture-session" },
    });
    const normalized = normalizeMcpResponseConnection(response);
    expect(normalized.headers.has("connection")).toBe(false);
    expect(normalized.status).toBe(207);
    expect(normalized.headers.get("mcp-session-id")).toBe("fixture-session");
    expect(await normalized.text()).toBe("fixture-payload");
  });
});
