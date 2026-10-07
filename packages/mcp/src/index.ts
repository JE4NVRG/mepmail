import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClient } from "./client.js";
import { registerTools } from "./tools.js";

declare const __MCP_VERSION__: string;
const VERSION = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : "0.0.0";

const API_KEY_ENVS = ["MEPMAIL_API_KEY", "MILLIONSEND_API_KEY"] as const;
const BASE_URL_ENVS = ["MEPMAIL_BASE_URL", "MILLIONSEND_BASE_URL"] as const;
const DEFAULT_BASE_URL = "https://api.mepmail.dev";

const firstEnv = (names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

const apiKey = firstEnv(API_KEY_ENVS);
if (!apiKey) {
  console.error(
    `[mepmail-mcp] ${API_KEY_ENVS.join(" or ")} is required. Create an API key in the MepMail dashboard (API keys) and set it in this MCP server's env.`,
  );
  process.exit(1);
}

const baseUrl = firstEnv(BASE_URL_ENVS) ?? DEFAULT_BASE_URL;
const client = createClient({ apiKey, baseUrl });

serveStdio(() => {
  const server = new McpServer(
    { name: "mepmail", version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, client);
  return server;
});

// stdout is the protocol wire — everything human-facing goes to stderr only.
console.error(`[mepmail-mcp] MepMail MCP server ready (${baseUrl})`);
