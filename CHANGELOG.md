# Changelog

All notable changes to MepMail are documented in this file, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers are the platform's deployment sequence; each entry is dated by
the day the change reached `main`. The same releases are published, per locale,
on the public [/changelog](https://mepmail.je4ndev.com/changelog) page.

## [0.48] - 2026-10-07

The OAuth MCP endpoint on api.mepmail.dev.

### Changed

- The MCP server answers at `https://api.mepmail.dev/mcp` with that host's
  RFC 9728 resource metadata; `api-mepmail.je4ndev.com/mcp` keeps its own.
  Tokens bound to either identifier are accepted on both hosts.
- The authorization server registers both MCP resource identifiers; newly
  registered clients are linked to both, and `linkClientsToResource` links
  clients registered before. The issuer identifier is unchanged.
- Docs, snippets, the MCP settings page, the server card and the discovery
  files show `https://api.mepmail.dev/mcp`.

## [0.47] - 2026-10-07

Public hosts on mepmail.dev.

### Added

- `https://api.mepmail.dev` (REST API and the Correio MCP at `/mcp/correio`),
  `https://docs.mepmail.dev` and `smtp.mepmail.dev` (port 2587, STARTTLS), in
  front of the same services.
- `ADVERTISED_API_URL`: an optional second public API hostname the dashboard
  prints, while MCP tokens stay bound to `PUBLIC_API_URL`.

### Changed

- The site, dashboard snippets, docs, agent discovery files and the OpenAPI
  server point at the mepmail.dev hosts. The je4ndev.com hosts keep serving;
  the old docs host redirects. The OAuth MCP endpoint and its issuer stay on
  je4ndev.com until connected agents can move.

## [0.46] - 2026-10-07

A Send price ladder where moving up always costs less per email.

### Changed

- Pro 220K is US$55 (was US$100), Scale 550K US$129 (was US$199), Scale 1.1M
  US$239 (was US$319) and Scale 1.65M US$349 (was US$429). Pro 110K stays at
  the US$29 launch price and Scale 2.75M at US$549.
- Overage per 1,000: US$0.35 on Pro 110K (was US$0.90), US$0.32 on Pro 220K,
  then US$0.29, 0.26, 0.24 and 0.22 up the Scale rungs: always above the
  rung's own per-email price, never the US$0.90 jump.
- New Stripe prices rotate in behind the same lookup keys; existing
  subscriptions keep the price they are on.

## [0.45] - 2026-10-07

Correio: email inboxes for your AI agents.

### Added

- Correio opens to every paying Send subscriber: mailboxes on the team's own
  domain for people and agents, from US$5.90 per mailbox a month.
- The Correio MCP server at `https://api-mepmail.je4ndev.com/mcp/correio`: an
  agent lists, reads, drafts and sends with its mailbox key (`mmb_`).
- Owner approval: an agent key without the send permission asks to send, the
  owner is emailed and the draft shows "Awaiting your approval" until they
  decide.
- `list_mailboxes`, `create_mailbox` and `create_mailbox_agent_key` on the main
  MCP server, behind the new `mailboxes:read` and `mailboxes:write` scopes.
- Correio runs as its own full-window app (`/mail`, `/mail/settings`) with a
  Send button in the composer, and `/correio` shows an animated agent demo.
- The home, `/pricing`, `/integrations`, the sitemap and the agent discovery
  files (llms.txt, the agent skill, the AI catalog) now present Correio.

### Changed

- Pre-send protection: disguised senders and subjects are refused, and young
  teams imitating banks, carriers or account-security mail are held for review.

## [0.44] - 2026-09-29

Value-first landing, official logos and +10% quotas.

### Added

- The landing now leads with the value proposition and a mural of official
  integration logos instead of a feature wall.
- Official, full-colour brand marks across the home, `/integrations` and the
  product mockup.
- A flat, responsive header with a balanced footer — Product, Compare, Account
  and Legal columns on every public page.

### Changed

- Sending quotas raised by 10% end to end (core, panel, docs and tests).

### Fixed

- A back-to-site link on the authentication screens, so sign-in and sign-up no
  longer strand the visitor.

## [0.43] - 2026-09-29

Institutional pages and plan limits v2.

### Added

- `/security` and `/support` as showcase pages: controls, subprocessors, the
  compliance roadmap (SOC 2 / ISO 27001 as roadmap items, never headlines) and
  the enterprise FAQ.
- `/integrations`, with the vendor mural and per-tool setup cards.
- `security.txt`.

### Changed

- Plan limits v2: more domains and workspaces, unlimited contacts on Starter.

### Fixed

- Localised landing prices (US separators in English, per-locale volume labels).

## [0.42] - 2026-09-29

Notification channels, templates and Microsoft sign-in.

### Added

- Slack, Discord and Telegram notification channels, formatted automatically
  from the webhook URL.
- A gallery of ready-made templates (10 starters, EN/PT) with preview and
  one-click copy.
- Social sign-in with Microsoft (better-auth), in both locales.

## [0.41] - 2026-09-28

Console, operator tooling and agent discovery.

### Added

- An operator `Console`: instance users, audit, regions and safety, plus a Users
  tile in the overview.
- The MCP server card now also served at the MCP endpoint origin, with its
  `tools[]` published.
- Channel attribution on sign-up and server-side funnel events in Umami.
- A Telegram alert on new sign-ups, carrying the utm/campaign origin.

### Changed

- Documentation wave 1: the npm packages page, rate limits with `Retry-After`,
  the error catalogue and the MCP install path.

## [0.40] - 2026-09-28

Open beta, SEO and self-serve docs.

### Added

- Open sign-up on the landing and in the docs: no invite, no seat limit; each
  account is capped at 100 emails a day on the Free plan.
- Self-hosted analytics (Umami) wired into the web app.
- `doctor` and `emails list/get` in the migration CLI.

### Changed

- `robots.txt` and `sitemap.xml` unblocked, with the legal pages indexed.

### Fixed

- Vitest `testTimeout` pinned in `apps/web`; a CLI 404 no longer blames the URL
  and `--after` is validated as a UUID.
- Mobile landing header kept on-screen, with the sign-up CTA always visible.

## [0.39] - 2026-09-27

Legal pages and a conversion-focused landing.

### Added

- Terms, Privacy and Refunds pages (PT/EN) with a fixed Legal column in the
  footer.
- Landing conversion round: demo, trust, founders program, FAQ, CTAs and the
  MCP section.
