# @mepmail/mcp

Official **MepMail** MCP server for local MCP clients — Claude Desktop, Claude
Code, Cursor, Codex and anything that speaks stdio. It drives your MepMail
instance over the public REST API (Resend-compatible wire) with a team API key,
and, with a Correio agent key, your **mailboxes**: read the inbox, save replies
as drafts and send them (or ask the owner to approve).

MepMail also runs a **hosted** MCP server (OAuth, no install) at
`https://api.mepmail.dev/mcp`. This package is for clients that launch
local servers from config. Tool names and result shapes match the hosted
server's; it covers a subset — the reading, sending and contact tools (22) —
and the write surfaces beyond contacts (segments, topics, broadcasts,
templates, webhooks, domains, API keys) plus the team picker are hosted-only.

Guide: <https://docs.mepmail.dev/mcp> ·
Packages: <https://docs.mepmail.dev/packages> · Published as
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
        "MEPMAIL_BASE_URL": "https://api.mepmail.dev"
      }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add mepmail -e MEPMAIL_API_KEY=ms_... -e MEPMAIL_BASE_URL=https://api.mepmail.dev -- npx -y @mepmail/mcp
```

**Correio mailboxes** — create an agent key in Correio → Settings → Agents:
`mmb_...` for one mailbox, or "Connect an agent to several mailboxes" for an
`mmt_...` credential over the mailboxes you choose, with read, draft and
optionally send permission. Then add it to the same server (an API key is
optional when you only need mailboxes):

```bash
claude mcp add mepmail -e MEPMAIL_MAIL_TOKEN=mmt_... -- npx -y @mepmail/mcp
```

## Environment

Set at least one of `MEPMAIL_API_KEY` and `MEPMAIL_MAIL_TOKEN`.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MEPMAIL_API_KEY` | for sending tools | — | Team API key (`ms_...`). Sent as `Bearer` to your instance only. |
| `MEPMAIL_BASE_URL` | no | `https://api.mepmail.dev` | Your instance's API URL. |
| `MEPMAIL_MAIL_TOKEN` | for mailbox tools | — | Correio agent key (`mmb_...` or `mmt_...`). Sent as `Bearer` to the dashboard origin only. |
| `MEPMAIL_MAIL_ORIGIN` | no | `https://mepmail.dev` | Where your dashboard answers. |

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

Correio mailboxes (with `MEPMAIL_MAIL_TOKEN`, same five tools as the hosted
`https://api.mepmail.dev/mcp/correio`):

- `mailbox_list_accounts` — the mailboxes the key reaches, with permissions
  and the default one.
- `mailbox_list_messages`, `mailbox_read_message` — inbox, drafts and sent;
  pass `mailbox` with a team credential.
- `mailbox_save_draft` — new draft, edit, reply or forward, from that
  mailbox's address and signature.
- `mailbox_send_draft` — sends with the send permission; otherwise the owner
  gets an approval request (`awaiting_approval`).

Every tool result is one JSON block envelope — `{ notice, untrusted_data }` —
so agents can tell team-authored strings from tool output and never treat
recipient data as instructions.

## Agent discovery

- Machine catalog: <https://mepmail.dev/.well-known/ai-catalog.json>
- Auth guide for agents: <https://mepmail.dev/auth.md>
- API + errors + rate limits: <https://docs.mepmail.dev>

## License

MIT
