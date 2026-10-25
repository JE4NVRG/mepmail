# MepMail plugin

Hosted OAuth MCP integration for Grok Bot and Cursor. Version 0.1.0.

Send email, check delivery status, and read or draft in selected MepMail mailboxes with OAuth-controlled access.

## What it does

MepMail connects your assistant to transactional email and selected Correio mailboxes. Send from a verified sender domain, inspect sent-message status, and read messages or save drafts in mailboxes explicitly selected at OAuth consent. Available tools are determined by the scopes and team role you approve.

Free Send provides 100 emails/day with no card. Correio has separate entitlement requirements; this plugin does not include free Mail or create a mailbox. On Free Send, use a non-mailbox sender on the verified domain for `send_email`; a registered Correio mailbox sender needs the Correio workflow or a paid Send plan. Queue acceptance is not inbox delivery.

## Connect and grant only what is needed

Connect `https://api.mepmail.dev/mcp` through OAuth. No API key belongs in `mcp.json`. Choose one team and only the intended mailbox. Start with `emails:read` and `mail:read`; add `domains:read` only for verification diagnostics. Add `emails:send` for an authorized transactional send, or `mail:draft` for draft writing. Keep direct `mail:send` off unless specifically needed. Consent can bundle mailbox read/draft; inspect the actual summary rather than assuming a finer grant.

Routine review does not need API-key creation, webhook access, domain writes, mailbox administration, audience writes, broadcasts or campaigns. `mailbox_send_draft` may request owner approval even without direct-send permission; do not invoke it in a no-send review.

## Install

Marketplace repository: https://github.com/JE4NVRG/mepmail

The repository-root `.cursor-plugin/marketplace.json` indexes `plugins/mepmail`. The plugin contains `.cursor-plugin/plugin.json`, `mcp.json` and `skills/mepmail/SKILL.md`; MCP and skill locations are auto-discovered. Marketplace publication remains subject to independent review by the platform. Repository presence is not marketplace acceptance.

For a no-send test, inspect the catalog, call `get_usage`, then read the non-sensitive seeded message in the dedicated reviewer mailbox through `mailbox_list_accounts` → `mailbox_list_messages` → `mailbox_read_message`. Outbound history is not an inbox; `check_mailbox` is readiness, not message reading. Reviewer credentials are supplied privately, never in this repository or archive.

## Verification and limits

The submission fixture was exercised against the live hosted endpoint with OAuth/PKCE, scoped tool discovery and one controlled transactional send followed by exact message-body readback in its own inbox. This is not a claim that the plugin was installed inside Grok Bot or Cursor. Do not attest to client-app testing until it is actually performed. Persistent draft creation was not part of that no-notification probe.

## License boundary

This original plugin package (manifest, MCP configuration and skill) is MIT, see LICENSE in this directory. It does not vendor or relicense the MepMail backend. The separately licensed server remains AGPL-3.0 at the repository root; the separately published `@mepmail/mcp` client has its own MIT license and notices.

Docs: https://docs.mepmail.dev/mcp
Support: suporte@mepmail.dev
