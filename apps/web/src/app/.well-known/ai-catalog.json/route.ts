/**
 * AI catalog (ai-catalog.json): the single document an agent reads to find
 * everything MepMail publishes for machines — the MCP server card, the API
 * catalog, the OpenAPI definition, auth instructions and llms.txt.
 *
 * Served at /.well-known/ai-catalog.json; modelled on the shape the Postmark
 * catalog made the de-facto standard (specVersion 1.0, urn:air identifiers).
 */
const BODY = JSON.stringify(
  {
    specVersion: "1.0",
    host: {
      displayName: "MepMail",
      identifier: "mepmail.je4ndev.com",
      documentationUrl: "https://docs-mepmail.je4ndev.com",
      logoUrl: "https://mepmail.je4ndev.com/logo/mepmail-avatar.svg",
    },
    entries: [
      {
        identifier: "urn:air:je4ndev.com:mepmail:mcp",
        displayName: "MepMail MCP server",
        description:
          "Server card for the hosted MepMail MCP server: send and manage transactional email, broadcasts, domains, contacts, templates, webhooks and API keys from an AI assistant.",
        type: "application/mcp-server-card+json",
        url: "https://mepmail.je4ndev.com/.well-known/mcp/server-card.json",
        representativeQueries: [
          "send a transactional email with MepMail",
          "connect MepMail to Claude or ChatGPT",
          "which MepMail MCP tools are available",
          "set up the MepMail MCP server",
        ],
        version: "0.6.69",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:api:catalog",
        displayName: "MepMail API catalog",
        description:
          "RFC 9727 linkset: where the MepMail API lives, its machine-readable definition and its documentation.",
        type: "application/linkset+json",
        url: "https://mepmail.je4ndev.com/.well-known/api-catalog",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:api:openapi",
        displayName: "MepMail API (OpenAPI 3.1)",
        description:
          "Machine-readable definition of every MepMail REST endpoint. The API is compatible with the Resend wire protocol.",
        type: "application/json",
        url: "https://api-mepmail.je4ndev.com/openapi.json",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:auth:instructions",
        displayName: "MepMail authentication for agents",
        description:
          "How an agent authenticates to MepMail: API keys for the REST API and SMTP relay, OAuth 2.1 for the MCP server, failure modes and rotation.",
        type: "text/markdown",
        url: "https://mepmail.je4ndev.com/auth.md",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:agent:skills",
        displayName: "MepMail agent skills",
        description:
          "Skills index (agentskills.io discovery): the MepMail SKILL.md an agent loads to send, migrate and troubleshoot correctly — auth, quotas, rate limits and error names included.",
        type: "application/json",
        url: "https://mepmail.je4ndev.com/.well-known/agent-skills/index.json",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:docs:llms-txt",
        displayName: "MepMail llms.txt",
        description: "A brief map of MepMail for LLMs.",
        type: "text/plain",
        url: "https://mepmail.je4ndev.com/llms.txt",
      },
      {
        identifier: "urn:air:je4ndev.com:mepmail:docs:site",
        displayName: "MepMail documentation",
        description: "Human-facing guides: quickstart, SDKs, MCP, error reference and rate limits.",
        type: "text/html",
        url: "https://docs-mepmail.je4ndev.com",
      },
    ],
  },
  null,
  2,
);

export function GET(): Response {
  return new Response(BODY, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
