import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClient } from "./client.js";
import { registerTools } from "./tools.js";

declare const __MCP_VERSION__: string;
const VERSION = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : "0.0.0";

const API_KEY_ENV = "MILLIONSEND_API_KEY";
const BASE_URL_ENV = "MILLIONSEND_BASE_URL";
const DEFAULT_BASE_URL = "https://api-mepmail.je4ndev.com";

const apiKey = process.env[API_KEY_ENV]?.trim();
if (!apiKey) {
  console.error(
    `[mepmail-mcp] ${API_KEY_ENV} is required. Create an API key in the MepMail dashboard (API keys) and set it in this MCP server's env.`,
  );
  process.exit(1);
}

const baseUrl = process.env[BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL;
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
