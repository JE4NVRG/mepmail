const BODY = `# MepMail

> This host is the MepMail dashboard (sign-in required). Documentation lives on the docs site below.

- Documentation: https://docs-mepmail.je4ndev.com
- Full documentation in one file: https://docs-mepmail.je4ndev.com/llms-full.txt
- OpenAPI 3.1 spec: https://api-mepmail.je4ndev.com/openapi.json
- For agents (auth, MCP, discovery): https://mepmail.je4ndev.com/auth.md
- Agent skills index: https://mepmail.je4ndev.com/.well-known/agent-skills/index.json
- AI catalog (everything published for agents): https://mepmail.je4ndev.com/.well-known/ai-catalog.json
- MCP server (hosted, OAuth): https://api-mepmail.je4ndev.com/mcp

## Correio: email inboxes for AI agents

- What it is: https://mepmail.je4ndev.com/correio
- Correio MCP server (one mailbox, mmb_ key): https://api-mepmail.je4ndev.com/mcp/correio
- Mailboxes guide (MCP, agent API, owner approval): https://docs-mepmail.je4ndev.com/mailboxes
`;

export function GET(): Response {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
