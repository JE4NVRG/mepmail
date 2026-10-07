import { MCP_TOOLS } from "./mcp-tools.js";

/**
 * MCP server card for the hosted MepMail MCP server. Both apps serve it: the
 * dashboard (APP_BASE_URL) at /.well-known/mcp/server-card.json, advertised by
 * its /.well-known/ai-catalog.json and linked from auth.md, and the API on the
 * MCP endpoint's own origin. One module, so the two origins cannot disagree.
 *
 * Unlike Postmark's card (a local stdio server via npx), MepMail ships a
 * hosted MCP endpoint: streamable HTTP authenticated with OAuth 2.1, so the
 * card carries the resource/authorization-server discovery URLs instead of a
 * launch command.
 *
 * The card is also what a directory reads when it cannot scan the endpoint
 * itself: an OAuth 2.1 server answers the scanner with a 401, so a scan can
 * only finish once a signed-in human grants consent. Smithery and Glama fall
 * back to this document ("publish a static server card",
 * smithery.mintlify.app/build/external "Option 3: Publish a static server
 * card", fetched "on your server" — i.e. on the origin of the MCP URL the
 * directory was pointed at, NOT on the marketing host). Measured on
 * 2026-09-28 with SmitheryBot/1.0: the scan of
 * https://api-mepmail.je4ndev.com/mcp fetched
 * https://api-mepmail.je4ndev.com/.well-known/mcp/server-card.json and got the
 * API's 404, then fell through to the interactive OAuth prompt — which is why
 * the API must serve this document too, not only the dashboard.
 *
 * `tools` carries the registry the settings page mirrors — name and
 * description per tool, taken from apps/api/src/mcp.ts — so a token's
 * tools/list and this card cannot drift. inputSchema is deliberately absent:
 * the card is static and the zod schemas live in the API, so publishing a
 * hand-written schema would be a second, unchecked source of truth.
 */

/** What the card publishes per tool: the fields it can attest to. */
const TOOLS = MCP_TOOLS.map(({ name, description }) => ({ name, description }));

export const MCP_SERVER_CARD = {
  $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  name: "com.je4ndev/mepmail",
  version: "0.6.69",
  description:
    "Official MepMail MCP server (hosted): transactional email with a Resend-compatible API. Send and manage emails, broadcasts, domains, contacts, templates, webhooks, API keys and Correio mailboxes for AI agents from AI assistants.",
  title: "MepMail",
  websiteUrl: "https://docs-mepmail.je4ndev.com",
  repository: {
    url: "https://github.com/JE4NVRG/mepmail",
    source: "github",
  },
  icons: [
    {
      src: "https://mepmail.je4ndev.com/logo/mepmail-avatar.svg",
      mimeType: "image/svg+xml",
    },
  ],
  serverInfo: {
    name: "com.je4ndev/mepmail",
    title: "MepMail",
    version: "0.6.69",
    description:
      "Hosted MCP server for transactional email, broadcasts, domains, contacts, templates, webhooks and Correio mailboxes.",
  },
  capabilities: {
    // The tool set follows the token's scopes and never changes mid-connection.
    tools: { listChanged: false },
  },
  tools: TOOLS,
  transport: {
    type: "streamable-http",
    url: "https://api-mepmail.je4ndev.com/mcp",
  },
  authentication: {
    required: true,
    type: "oauth2",
    schemes: ["oauth2"],
    authorizationServer: "https://mepmail.je4ndev.com",
    resourceMetadata: "https://api-mepmail.je4ndev.com/.well-known/oauth-protected-resource",
    authorizationServerMetadata:
      "https://mepmail.je4ndev.com/.well-known/oauth-authorization-server",
    scopes: [
      "offline_access",
      "emails:send",
      "emails:read",
      "audience:read",
      "audience:write",
      "broadcasts:read",
      "broadcasts:write",
      "domains:read",
      "domains:write",
      "templates:read",
      "templates:write",
      "webhooks:write",
      "api-keys:write",
      "mailboxes:read",
      "mailboxes:write",
    ],
    instructionsUrl: "https://mepmail.je4ndev.com/auth.md",
    description:
      "The MCP endpoint answers 401 with a WWW-Authenticate challenge; MCP clients then follow the OAuth 2.1 discovery documents above. API keys do not authenticate this endpoint. The tools a token exposes depend on the scopes it carries.",
  },
  relatedResources: {
    aiCatalog: "https://mepmail.je4ndev.com/.well-known/ai-catalog.json",
    apiCatalog: "https://mepmail.je4ndev.com/.well-known/api-catalog",
    authInstructions: "https://mepmail.je4ndev.com/auth.md",
    llmsTxt: "https://mepmail.je4ndev.com/llms.txt",
    docs: "https://docs-mepmail.je4ndev.com",
  },
} as const;

/** The card as served — pretty-printed, identical on both origins. */
const BODY = JSON.stringify(MCP_SERVER_CARD, null, 2);

export function mcpServerCardBody(): string {
  return BODY;
}

/** The one content type both origins answer with. */
export const MCP_SERVER_CARD_CONTENT_TYPE = "application/json; charset=utf-8";
