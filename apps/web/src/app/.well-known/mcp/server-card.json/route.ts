/**
 * MCP server card for the hosted MepMail MCP server. Advertised by
 * /.well-known/ai-catalog.json and linked from auth.md.
 *
 * Unlike Postmark's card (a local stdio server via npx), MepMail ships a
 * hosted MCP endpoint: streamable HTTP authenticated with OAuth 2.1, so the
 * card carries the resource/authorization-server discovery URLs instead of a
 * launch command.
 */
const BODY = JSON.stringify(
  {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "com.je4ndev/mepmail",
    version: "0.6.69",
    description:
      "Official MepMail MCP server (hosted): transactional email with a Resend-compatible API. Send and manage emails, broadcasts, domains, contacts, templates, webhooks and API keys from AI assistants.",
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
        "Hosted MCP server for transactional email, broadcasts, domains, contacts, templates and webhooks.",
    },
    capabilities: {
      tools: {},
    },
    transport: {
      type: "streamable-http",
      url: "https://api-mepmail.je4ndev.com/mcp",
    },
    authentication: {
      required: true,
      type: "oauth2",
      authorizationServer: "https://mepmail.je4ndev.com",
      resourceMetadata:
        "https://api-mepmail.je4ndev.com/.well-known/oauth-protected-resource",
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
  },
  null,
  2,
);

export function GET(): Response {
  return new Response(BODY, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
