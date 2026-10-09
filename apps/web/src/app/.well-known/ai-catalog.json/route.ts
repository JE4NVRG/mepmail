/**
 * AI catalog (ai-catalog.json): the single document an agent reads to find
 * everything MepMail publishes for machines — the MCP server card, the Correio
 * MCP for agent inboxes, the API catalog, the OpenAPI definition, auth
 * instructions and llms.txt.
 *
 * Served at /.well-known/ai-catalog.json; modelled on the shape the Postmark
 * catalog made the de-facto standard (specVersion 1.0, urn:air identifiers).
 */
const BODY = JSON.stringify(
  {
    specVersion: "1.0",
    host: {
      displayName: "MepMail",
      identifier: "mepmail.dev",
      documentationUrl: "https://docs.mepmail.dev",
      logoUrl: "https://mepmail.dev/logo/mepmail-avatar.svg",
    },
    entries: [
      {
        identifier: "urn:air:mepmail.dev:mcp",
        displayName: "MepMail MCP server",
        description:
          "Server card for the hosted MepMail MCP server: send and manage transactional email, broadcasts, domains, contacts, templates, webhooks, API keys and Correio mailboxes from an AI assistant.",
        type: "application/mcp-server-card+json",
        url: "https://mepmail.dev/.well-known/mcp/server-card.json",
        representativeQueries: [
          "send a transactional email with MepMail",
          "connect MepMail to Claude or ChatGPT",
          "which MepMail MCP tools are available",
          "set up the MepMail MCP server",
        ],
        version: "0.6.69",
      },
      {
        identifier: "urn:air:mepmail.dev:correio:mcp",
        displayName: "MepMail Correio MCP server (email inboxes for AI agents)",
        description:
          "Give an AI agent its own mailbox on your domain. Streamable HTTP at https://api.mepmail.dev/mcp/correio with a per-mailbox mmb_ key: list and read messages, save drafts and send, with optional owner approval before each send. This entry links to its guide.",
        type: "text/html",
        url: "https://docs.mepmail.dev/mailboxes",
        representativeQueries: [
          "give my AI agent an email inbox",
          "email inbox for an AI agent over MCP",
          "let an agent read and answer email with approval",
          "set up the MepMail Correio MCP server",
        ],
      },
      {
        identifier: "urn:air:mepmail.dev:correio",
        displayName: "MepMail Correio",
        description:
          "Email inboxes for people and AI agents on your own domain, paid per mailbox on top of a MepMail Send plan.",
        type: "text/html",
        url: "https://mepmail.dev/correio",
      },
      {
        identifier: "urn:air:mepmail.dev:api:catalog",
        displayName: "MepMail API catalog",
        description:
          "RFC 9727 linkset: where the MepMail API lives, its machine-readable definition and its documentation.",
        type: "application/linkset+json",
        url: "https://mepmail.dev/.well-known/api-catalog",
      },
      {
        identifier: "urn:air:mepmail.dev:api:openapi",
        displayName: "MepMail API (OpenAPI 3.1)",
        description:
          "Machine-readable definition of every MepMail REST endpoint. The API is compatible with the Resend wire protocol.",
        type: "application/json",
        url: "https://api.mepmail.dev/openapi.json",
      },
      {
        identifier: "urn:air:mepmail.dev:auth:instructions",
        displayName: "MepMail authentication for agents",
        description:
          "How an agent authenticates to MepMail: API keys for the REST API and SMTP relay, OAuth 2.1 for the MCP server, failure modes and rotation.",
        type: "text/markdown",
        url: "https://mepmail.dev/auth.md",
      },
      {
        identifier: "urn:air:mepmail.dev:agent:skills",
        displayName: "MepMail agent skills",
        description:
          "Skills index (agentskills.io discovery): the MepMail SKILL.md an agent loads to send, migrate and troubleshoot correctly — auth, quotas, rate limits and error names included.",
        type: "application/json",
        url: "https://mepmail.dev/.well-known/agent-skills/index.json",
      },
      {
        identifier: "urn:air:mepmail.dev:docs:llms-txt",
        displayName: "MepMail llms.txt",
        description: "A brief map of MepMail for LLMs.",
        type: "text/plain",
        url: "https://mepmail.dev/llms.txt",
      },
      {
        identifier: "urn:air:mepmail.dev:docs:site",
        displayName: "MepMail documentation",
        description: "Human-facing guides: quickstart, SDKs, MCP, error reference and rate limits.",
        type: "text/html",
        url: "https://docs.mepmail.dev",
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
