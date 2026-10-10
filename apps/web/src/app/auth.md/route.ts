/**
 * auth.md — the agent-facing authentication document (text/markdown),
 * modelled on Postmark's auth.md. Advertised by /.well-known/ai-catalog.json
 * and /llms.txt. Keep it honest: every URL and error name here must exist.
 */
const BODY = `# auth.md

Not an agent? You're looking for <https://docs.mepmail.dev>.

You are an agent. This document tells you how to authenticate to **MepMail**,
a transactional email service with a Resend-compatible API. Read it fully
before your first request.

## Two credential systems

MepMail authenticates two different kinds of caller:

1. **REST API and SMTP relay** use long-lived **API keys** (\`ms_...\`) sent as
   a bearer token. This is what most agents need.
2. **The hosted MCP server** uses **OAuth 2.1**, because MCP clients expect a
   standard authorization flow. API keys do not authenticate the MCP endpoint,
   and MCP access tokens are not accepted on the REST API.

## API keys

| Credential | Where it goes | Grants |
| --- | --- | --- |
| **API key** | \`Authorization: Bearer ms_...\` | Every endpoint the team can use |
| **Sending-access key** | \`Authorization: Bearer ms_...\` | Sending endpoints only; everything else answers \`403 restricted_api_key\` |
| **SMTP relay credentials** | SMTP AUTH at \`smtp.mepmail.dev\` port \`2587\` (STARTTLS), username \`mepmail\`, password = a sending-access key | The same sending surface, over SMTP |

Keys are opaque strings that start with \`ms_\`. A key can also be restricted
to one sender domain at creation time; sending from any other domain answers
\`403 restricted_api_key\` — that is a policy answer, not a credential failure.

## Getting a credential

There is no unauthenticated endpoint that mints API keys: key creation is an
authenticated, interactive action a human completes in the MepMail dashboard.
You cannot finish it yourself, and you should not automate the dashboard. Ask
your operator for a **dedicated sending-access key** for the agent, supplied
through the secret store you are configured with — never pasted into
transcripts, commits, tickets or prompts that will be logged.

## Using a key

Base URL: \`https://api.mepmail.dev\`

\`\`\`
POST /emails HTTP/1.1
Host: api.mepmail.dev
Authorization: Bearer ms_...
Content-Type: application/json

{
  "from": "you@yourdomain.com",
  "to": "recipient@example.com",
  "subject": "Hello",
  "html": "<p>Hello from an agent.</p>"
}
\`\`\`

Every endpoint is defined in the OpenAPI document linked from
<https://mepmail.dev/.well-known/api-catalog>.

## Before your first real send

- The \`from\` address must belong to a **verified sending domain** of the
  team (DKIM/MAIL FROM configured by a human in the dashboard). Until then
  sends fail on the sender domain — report it to your operator instead of
  retrying, because only they can complete verification.
- MepMail has no sandbox or test-token mode. Verify a new credential with a
  read call your key is scoped for, or with a first send to a mailbox you
  control. Addresses such as \`delivered@resend.dev\` seen in compatibility
  examples are illustrative values, not a simulator.

## When authentication fails

\`\`\`
HTTP/1.1 401 Unauthorized

{"statusCode":401,"name":"invalid_api_key","message":"API key is invalid"}
\`\`\`

A missing header answers \`name: "missing_api_key"\`. A \`401\` is terminal:
the credential is wrong. Do not retry it with backoff — waiting does not make
a bad key valid. Re-read the key from your secret store once (it may have been
rotated), and if it still fails, stop and report to your operator.

\`403 restricted_api_key\` is a different thing: the key is valid but not
allowed for that resource (wrong permission level, or a sender domain the key
is not scoped to). Fix what you ask for, or ask the operator for a key with
the right scope. \`422 validation_error\` means the credential was accepted and
the *request* was wrong; fix the request. The full error catalog is at
<https://docs.mepmail.dev/errors>.

## Rotation and revocation

Keys do not expire on their own. A human can revoke any key in the dashboard,
which takes effect immediately and invalidates the old value. Treat rotation
as expected rather than exceptional: read the key from the environment or
secret store rather than caching it for the life of the process, so a rotation
does not require a restart. On a \`401\` for a credential that previously
worked, assume it was rotated or revoked and re-read it once.

## Least privilege

- Ask for a dedicated sending-access key, restricted to the agent's sending
  domain, unless the task truly needs account-wide reads or writes.
- Hold the credential in memory for as long as the task needs it. Do not copy
  it into logs, error reports, traces, or files.

## OAuth 2.1 for the MCP server

The hosted MCP endpoint lives at \`https://api.mepmail.dev/mcp\` and
answers \`401\` with a \`WWW-Authenticate\` challenge that points MCP clients at:

- Resource metadata:
  <https://api.mepmail.dev/.well-known/oauth-protected-resource>
- Authorization server metadata:
  <https://mepmail.dev/.well-known/oauth-authorization-server>

MCP clients self-register (RFC 7591) and run the authorization-code flow with
PKCE. Scopes mirror the API surfaces:

\`emails:send\`, \`emails:read\`, \`audience:read\`, \`audience:write\`,
\`broadcasts:read\`, \`broadcasts:write\`, \`domains:read\`, \`domains:write\`,
\`templates:read\`, \`templates:write\`, \`webhooks:write\`,
\`api-keys:write\`, \`mailboxes:read\`, \`mailboxes:write\`, \`mail:read\`,
\`mail:draft\`, \`mail:send\`, plus \`offline_access\` for refresh tokens. The
\`mail:*\` scopes act only in the Correio mailboxes the person ticks on the
consent screen. Access tokens
are audience-bound to the MCP resource and are not accepted on the REST API.

## Related discovery documents

| Document | What it is |
| --- | --- |
| <https://mepmail.dev/.well-known/ai-catalog.json> | Everything MepMail publishes for agents |
| <https://mepmail.dev/.well-known/api-catalog> | The API, its OpenAPI definition and docs (RFC 9727) |
| <https://mepmail.dev/.well-known/mcp/server-card.json> | The MCP server card |
| <https://mepmail.dev/llms.txt> | What MepMail is, in brief |
| <https://docs.mepmail.dev> | Human-facing documentation |

Human support, if you need to escalate to your operator:
<mailto:suporte@mepmail.dev>.
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
