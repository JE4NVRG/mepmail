import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createClient } from "./client.js";
import { CORREIO_INSTRUCTIONS, MAIL_TOKEN, registerCorreioTools } from "./correio.js";
import { registerTools } from "./tools.js";

declare const __MCP_VERSION__: string;
const VERSION = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : "0.0.0";

const API_KEY_ENVS = ["MEPMAIL_API_KEY", "MILLIONSEND_API_KEY"] as const;
const BASE_URL_ENVS = ["MEPMAIL_BASE_URL", "MILLIONSEND_BASE_URL"] as const;
const DEFAULT_BASE_URL = "https://api.mepmail.dev";
// Correio (mailboxes) answers on the dashboard origin, with a mailbox agent key.
const MAIL_TOKEN_ENVS = ["MEPMAIL_MAIL_TOKEN"] as const;
const MAIL_ORIGIN_ENVS = ["MEPMAIL_MAIL_ORIGIN"] as const;
const DEFAULT_MAIL_ORIGIN = "https://mepmail.dev";

const firstEnv = (names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

const apiKey = firstEnv(API_KEY_ENVS);
const mailToken = firstEnv(MAIL_TOKEN_ENVS);
if (!apiKey && !mailToken) {
  console.error(
    `[mepmail-mcp] Set ${API_KEY_ENVS[0]} (an API key from the MepMail dashboard, for sending email) and/or ${MAIL_TOKEN_ENVS[0]} (an agent key from Correio → Settings → Agents, for mailboxes) in this MCP server's env.`,
  );
  process.exit(1);
}
if (mailToken && !MAIL_TOKEN.test(mailToken)) {
  console.error(
    `[mepmail-mcp] ${MAIL_TOKEN_ENVS[0]} must be a Correio agent key (mmb_… or mmt_…).`,
  );
  process.exit(1);
}

const baseUrl = firstEnv(BASE_URL_ENVS) ?? DEFAULT_BASE_URL;
const mailOrigin = firstEnv(MAIL_ORIGIN_ENVS) ?? DEFAULT_MAIL_ORIGIN;
const client = apiKey ? createClient({ apiKey, baseUrl }) : null;

serveStdio(() => {
  const server = new McpServer(
    { name: "mepmail", version: VERSION },
    { capabilities: { tools: {} }, ...(mailToken ? { instructions: CORREIO_INSTRUCTIONS } : {}) },
  );
  if (client) registerTools(server, client);
  if (mailToken) registerCorreioTools(server, { token: mailToken, origin: mailOrigin });
  return server;
});

// stdout is the protocol wire — everything human-facing goes to stderr only.
console.error(
  `[mepmail-mcp] MepMail MCP server ready (${[client ? `send: ${baseUrl}` : null, mailToken ? `mail: ${mailOrigin}` : null].filter(Boolean).join(", ")})`,
);
