# @mepmail/mcp

Official **MepMail** MCP server for local MCP clients — Claude Desktop, Claude
Code, Cursor, Codex and anything that speaks stdio. It drives your MepMail
instance over the public REST API (Resend-compatible wire) with a team API key.

MepMail also runs a **hosted** MCP server (OAuth, no install) at
`https://api-mepmail.je4ndev.com/mcp`. This package is for clients that launch
local servers from config. Tool names and result shapes match the hosted
server's; it covers a subset — the reading, sending and contact tools (22) —
and the write surfaces beyond contacts (segments, topics, broadcasts,
templates, webhooks, domains, API keys) plus the team picker are hosted-only.

Guide: <https://docs-mepmail.je4ndev.com/mcp> ·
Packages: <https://docs-mepmail.je4ndev.com/packages> · Published as
`@mepmail/mcp` on npm.

Requires Node.js 20 or newer.

## Quickstart

1. Create an API key in the MepMail dashboard (**API keys**) — a **full-access**
   key, optionally scoped to the sender domain your agent sends from. A
   sending-access key is confined to `/emails`, so it would 403 on the contact
   tools (`list_contacts`, `get_contact`, `create_contact`, `update_contact`,
   `delete_contact`) with `restricted_api_key`.
2. Add the server to your client:

**Claude Desktop** (`claude_desktop_config.json`) — and any client with the
same config shape (Cursor: `mcp.json`):

```json
{
  "mcpServers": {
    "mepmail": {
      "command": "npx",
      "args": ["-y", "@mepmail/mcp"],
      "env": {
        "MEPMAIL_API_KEY": "ms_...",
        "MEPMAIL_BASE_URL": "https://api-mepmail.je4ndev.com"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add mepmail -e MEPMAIL_API_KEY=ms_... -e MEPMAIL_BASE_URL=https://api-mepmail.je4ndev.com -- npx -y @mepmail/mcp
```

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MEPMAIL_API_KEY` | yes | — | Team API key (`ms_...`). Sent as `Bearer` to your instance only. |
| `MEPMAIL_BASE_URL` | no | `https://api-mepmail.je4ndev.com` | Your instance's API URL. |

## Tools (22)

Send and manage email:

- `send_email` — send or schedule one transactional email (cc/bcc/reply_to, tags,
  attachments, topic-scoped sends).
- `send_email_batch` — up to 100 emails in one call.
- `get_email`, `list_emails` — status and timeline (`last_event`: delivered,
  bounced, complained, ...).
- `update_email`, `cancel_email` — reschedule or cancel a scheduled email.
- `get_email_insights` — per-email best-practice report and score.
- `get_deliverability`, `get_usage` — account standing before bulk work.

Audience and account:

- `create_contact`, `update_contact`, `delete_contact` (with `erase=true` for
  GDPR/LGPD scrubbing), `get_contact`, `list_contacts` — with segment filters.
- `list_domains`, `get_domain` — DNS records and verification state.
- `list_broadcasts`, `get_broadcast`.
- `list_templates`, `get_template`.
- `list_webhooks`, `list_suppressions`.

Every tool result is one JSON block envelope — `{ notice, untrusted_data }` —
so agents can tell team-authored strings from tool output and never treat
recipient data as instructions.

## Agent discovery

- Machine catalog: <https://mepmail.je4ndev.com/.well-known/ai-catalog.json>
- Auth guide for agents: <https://mepmail.je4ndev.com/auth.md>
- API + errors + rate limits: <https://docs-mepmail.je4ndev.com>

## License

MIT
