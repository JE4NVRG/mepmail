<p align="center">
  <a href="https://mepmail.dev/"><img src="apps/web/public/logo/mepmail-banner.svg" alt="MepMail" width="560"></a>
</p>

<h3 align="center">Sending API, SMTP and real mailboxes on your domain for apps and AI agents, with official MCP.</h3>

<p align="center">
  <a href="https://mepmail.dev/"><b>Website</b></a> ·
  <a href="https://mepmail.dev/pricing">Pricing</a> ·
  <a href="https://docs.mepmail.dev/mcp">MCP Docs</a> ·
  <a href="https://www.npmjs.com/package/@mepmail/mcp">@mepmail/mcp 0.3.3</a> ·
  <a href="mailto:suporte@mepmail.dev">Support</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mepmail/mcp"><img src="https://img.shields.io/npm/v/@mepmail/mcp?label=%40mepmail%2Fmcp&color=7343E0" alt="@mepmail/mcp on npm"></a>
  <a href="https://docs.mepmail.dev/mcp"><img src="https://img.shields.io/badge/docs-docs.mepmail.dev%2Fmcp-7343E0" alt="MepMail MCP Documentation"></a>
  <a href="https://mepmail.dev/pricing"><img src="https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2B%20OAuth%202.1-7343E0" alt="Hosted MCP OAuth 2.1"></a>
  <a href="https://apps.microsoft.com/detail/9nhpx6qrf0pb"><img src="https://img.shields.io/badge/Windows-Microsoft%20Store-7343E0" alt="MepMail Correio on Windows"></a>
  <a href="https://kiro.dev/launch/mcp/add?name=MepMail&config=%7B%22url%22%3A%22https%3A//api.mepmail.dev/mcp%22%7D"><img src="https://kiro.dev/images/add-to-kiro.svg" alt="Add to Kiro"></a>
  <a href="https://glama.ai/mcp/servers/JE4NVRG/mepmail"><img src="https://glama.ai/mcp/servers/JE4NVRG/mepmail/badges/score.svg" alt="JE4NVRG/mepmail MCP server"></a>
</p>

---

## Overview

Sending API, SMTP and real mailboxes on your domain for apps and AI agents, with official MCP.

MepMail brings transactional sending and real domain mailboxes together in one platform:

- **Send (Transactional Email API & SMTP):** REST API (`https://api.mepmail.dev`), idempotency keys (`Idempotency-Key`), SMTP submission (`smtp.mepmail.dev:2587`, STARTTLS), guided DNS verification (SPF, DKIM, DMARC), webhooks, templates, contacts, suppressions, delivery tracking, and metrics.
- **Correio (Real Mailboxes on Your Domain):** Business and AI-agent inboxes on your custom domain with smart inbox tabs, rules, IMAP import, webmail, and desktop apps for [Windows](https://apps.microsoft.com/detail/9nhpx6qrf0pb) and [Linux](https://mepmail.dev/desktop/correio/linux).
- **Official MCP Server:** Hosted OAuth 2.1 server at `https://api.mepmail.dev/mcp` (Streamable HTTP) and local stdio package `@mepmail/mcp` (`0.3.3`) on npm.

---

## Official MCP Setup

### Option 1 — Hosted MCP (OAuth 2.1, recommended)

Connect directly to the hosted Streamable HTTP endpoint (no API key in config):

```json
{
  "mcpServers": {
    "mepmail": {
      "url": "https://api.mepmail.dev/mcp"
    }
  }
}
```

When connecting via OAuth 2.1, select one team and grant only the scopes your workflow requires (for example `emails:read`, `domains:read`, `emails:send`, `mail:read`, `mail:draft`, and optionally `mail:send`). See the full MCP setup guide at [docs.mepmail.dev/mcp](https://docs.mepmail.dev/mcp).

### Option 2 — Local stdio (`@mepmail/mcp` `0.3.3`)

Requires Node.js `>=20`. Create a team API key (`ms_...`) in the dashboard and/or a Correio agent key (`mmb_...` or `mmt_...`) under **Correio → Settings → Agents**.

**Cursor / Claude Desktop (`mcp.json` / `claude_desktop_config.json`):**

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

**Claude Code:**

```bash
claude mcp add mepmail \
  -e MEPMAIL_API_KEY=ms_... \
  -e MEPMAIL_BASE_URL=https://api.mepmail.dev \
  -- npx -y @mepmail/mcp
```

Set `MEPMAIL_MAIL_TOKEN` (`mmb_...` or `mmt_...`) when using mailbox tools (`mailbox_list_accounts`, `mailbox_list_messages`, `mailbox_read_message`, `mailbox_get_attachment`, `mailbox_save_draft`, `mailbox_send_draft`). Every tool response separates untrusted email content into `{ notice, untrusted_data }` and supports owner approval before sending drafts.

---

## REST API & SMTP Quickstart

**REST API (`https://api.mepmail.dev/emails`):**

```sh
curl -X POST https://api.mepmail.dev/emails \
  -H "Authorization: Bearer ms_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042" \
  -d '{
    "from": "Acme <onboarding@acme.dev>",
    "to": ["user@example.com"],
    "subject": "Welcome to Acme",
    "html": "<strong>Your account is ready.</strong>"
  }'
```

**SMTP Relay:**

- Host: `smtp.mepmail.dev`
- Port: `2587` (`STARTTLS`)
- Auth: your verified MepMail API key (`ms_...`)

---

## Plans & Sending Limits

All plans follow published quotas, domain verification, warm-up stages, and regional capacity rules on [mepmail.dev/pricing](https://mepmail.dev/pricing):

- **Send:** Free (`100 emails/day`, no card), Starter (`1,500 emails/day`), Pro (`110,000 emails/month` and `220,000 emails/month`), Scale (`550,000 emails/month` and `1,100,000 emails/month`). Larger custom volumes are available on inquiry.
- **Correio (Domain Mailboxes):** Solo (`1 mailbox`), Duo (`3 mailboxes`), and Equipe (`10 mailboxes`), with per-plan storage and monthly message allowances listed at [mepmail.dev/pricing](https://mepmail.dev/pricing).

Sending requires email and sender domain verification; new domains start with warm-up limits and scale according to measured deliverability and reputation.

---

## Discovery & Machine Endpoints

- MCP Server Card: [https://mepmail.dev/.well-known/mcp/server-card.json](https://mepmail.dev/.well-known/mcp/server-card.json)
- AI Catalog: [https://mepmail.dev/.well-known/ai-catalog.json](https://mepmail.dev/.well-known/ai-catalog.json)
- Agent Auth Guide: [https://mepmail.dev/auth.md](https://mepmail.dev/auth.md)
- OpenAPI Spec: [https://api.mepmail.dev/openapi.json](https://api.mepmail.dev/openapi.json)
- LLMs Summary: [https://mepmail.dev/llms.txt](https://mepmail.dev/llms.txt)

---

## Links & Support

- **Homepage:** [mepmail.dev](https://mepmail.dev/)
- **MCP Documentation:** [docs.mepmail.dev/mcp](https://docs.mepmail.dev/mcp)
- **General Docs:** [docs.mepmail.dev](https://docs.mepmail.dev)
- **Pricing & Limits:** [mepmail.dev/pricing](https://mepmail.dev/pricing)
- **Support:** [suporte@mepmail.dev](mailto:suporte@mepmail.dev)
- **Privacy Policy:** [mepmail.dev/privacy](https://mepmail.dev/privacy)

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for licensing terms (`@mepmail/mcp` and `@mepmail/cli` are MIT-licensed).
