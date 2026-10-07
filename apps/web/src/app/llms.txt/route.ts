const BODY = `# MepMail

> This host is the MepMail dashboard (sign-in required). Documentation lives on the docs site below.

- Documentation: https://docs.mepmail.dev
- Full documentation in one file: https://docs.mepmail.dev/llms-full.txt
- OpenAPI 3.1 spec: https://api.mepmail.dev/openapi.json
- For agents (auth, MCP, discovery): https://mepmail.dev/auth.md
- Agent skills index: https://mepmail.dev/.well-known/agent-skills/index.json
- AI catalog (everything published for agents): https://mepmail.dev/.well-known/ai-catalog.json
- MCP server (hosted, OAuth): https://api-mepmail.je4ndev.com/mcp

## Correio: email inboxes for AI agents

- What it is: https://mepmail.dev/correio
- Correio MCP server (one mailbox, mmb_ key): https://api.mepmail.dev/mcp/correio
- Mailboxes guide (MCP, agent API, owner approval): https://docs.mepmail.dev/mailboxes
`;

export function GET(): Response {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
