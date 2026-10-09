# Changelog

All notable changes to MepMail are documented in this file, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers are the platform's deployment sequence; each entry is dated by
the day the change reached `main`. The same releases are published, per locale,
on the public [/changelog](https://mepmail.je4ndev.com/changelog) page.

## [0.68] - 2026-10-09

Correio inbox: undo and an unread filter.

### Added

- Undo for archive and trash, single and bulk (including drag and drop): each
  step records the reverse mutation with the revision it returned; the offer
  is tied to its own notice, lasts 10 s and also answers the Z shortcut.
- "Unread" chip in the Inbox list header filters to unread inbox rows; the
  open message stays visible until you move on.

### Changed

- Trashing the open message no longer jumps to the Trash folder; restoring
  still shows where it went back to.

## [0.67] - 2026-10-09

Correio inbox: keyboard shortcuts and copy.

### Added

- `src/lib/mailbox-shortcuts.ts`: webmail keys (J/K, Esc, R, A, F, C, E, #,
  S, U, /, ?), ignored while typing, with modifiers, on repeats or inside a
  dialog. The inbox view registers one window listener that reads the current
  render through a ref and applies the same conditions as the matching buttons.
- A "?" help dialog listing the shortcuts, also opened from a toolbar button.

### Changed

- The reading pane header no longer falls back to "All mailboxes" when nothing
  is open.
- Empty inbox body, scope selector labels and the usage panel title fit one or
  several mailboxes; the System wording became "system account"; the storage
  progress track uses the strong line color so it shows when nearly empty.

## [0.66] - 2026-10-09

Support entry points for signed-in users.

### Added

- Dashboard sidebar "Support" link (`/support#chat`, document navigation so
  the /support policy loads the chat); `EloziSupport` opens the chat once when
  the page loads with `#chat` and clears the hash.
- Correio app header "Support" button, opening `/support#chat` in a new tab;
  hidden on narrow screens like the long back label.

## [0.65] - 2026-10-09

Support chat copy on /support.

### Changed

- The /support chat card describes the virtual assistant plainly (what it
  answers, that Jean replies by email for account and billing, never send a
  password, code or API key) and no longer names the chat vendor.
- The assistant's knowledge source on Elozi (not in this repository) was
  rewritten: domain DNS, SMTP, API limits, Correio setup, billing, and the
  rule that Correio has no free plan.

## [0.64] - 2026-10-09

Copy and state fixes from Sage's screen-by-screen review.

### Changed

- Mailboxes in the `planned` state (the live state) are labeled "Active" /
  "Ativa" instead of "Preparing" / "Em preparação".
- Landing MCP point: the hosted server has the full toolset, the local
  package covers the core sending tools (was "Both modes expose the same
  tools").
- Landing FAQ speaks of the Free plan instead of a beta; "Founders program"
  drops "(beta)"; the featured pricing badge reads "Recommended".
- Pricing ladder title and intro rewritten in both locales.
- English price strings use the same `US$ 29` spacing as `formatUsd`; the
  public nav calls the product "Mail" in English.
- pt-BR: "Página de cancelamento" becomes "Página de descadastro" (the
  unsubscribe page, not a subscription cancellation).

### Fixed

- `sendGuard.regionPaused` (shown to customers when a broadcast is refused
  during a platform pause) no longer names the region or the platform metric.
- The operator's breaker banner formats the rate for the locale (0,49 in
  pt-BR).
- `/settings/billing` shows a retry notice when `billing.status` fails instead
  of an endless skeleton.

## [0.63] - 2026-10-08

Team agent credentials for Correio: one secret over several mailboxes.

### Added

- Mailbox migration 0016: `mailbox_agent_keys.group_id` (nullable) and
  `is_default`, a unique (group_id, mailbox_id) index and a check that only
  grouped rows may be the default.
- A team credential (`mmt_<groupId>.<secret>`) is one key row per allowed
  mailbox sharing one hash, so each mailbox keeps its owner authorization,
  locks, seat gate, scopes, revocation on owner change, approval and
  activity. `createMailboxTeamAgentKey` (only the minting owner's active
  mailboxes, 1-20, optional default), `listMailboxTeamAgentKeys`,
  `revokeMailboxTeamAgentKey` and `listMailboxAgentAccounts`.
- `withMailboxAgentAccess` takes a mailbox selector (id or address): a team
  credential picks that row, else its default, else the only row, else
  `mailbox_required` (after the secret is verified); a mailbox key named for
  another mailbox is refused. `queueMailboxAgentDraft` passes it on.
- Agent API: `Authorization: Bearer mmt_…` plus the `MepMail-Mailbox` header
  on items, drafts and send; `GET /api/mailbox-agent/mailboxes` lists the
  credential's mailboxes. A send without the send scope still becomes the
  owner's approval request for the named mailbox.
- Correio MCP: `mailbox_list_accounts` and a `mailbox` argument on every tool,
  forwarded as the header.
- Correio settings, Agents: "Connect an agent to several mailboxes" with
  mailboxes, default, scopes and expiry; the token shows once.

### Fixed

- The agent label check no longer uses a control-character regex (lint).

## [0.62] - 2026-10-08

Visitor support chat on /support through Elozi.

### Added

- `eloziSupportChannel.enabled` is on: /support offers the Elozi webchat
  (tenant 499f0367, MepMail channel 6376dfa3, origin https://mepmail.dev).
  The module loads only after a click and receives no account identity.
- Elozi side, configured in its admin: channel reception on, assistant
  Hermes Elozi answering automatically for the MepMail product from the
  published source "MepMail · Suporte público PT/EN" (built from the /support
  FAQ, prices and terms), handing over to Jean for people, accounts, billing
  and security.

## [0.61] - 2026-10-08

Support FAQ in line with the product.

### Fixed

- /support FAQ (PT/EN): Correio is open as a US$ 9.90/month per mailbox
  add-on on any paid Send plan (10 GiB, 2,000 outbound deliveries a month),
  prices live on /pricing, and agents use the Correio MCP for mailboxes.
  The answers said Correio was closed to the operator account and unpriced.
  This FAQ is also the published source for the Elozi support assistant.

## [0.60] - 2026-10-08

Received HTML closer to the sender's design in the Correio reader.

### Fixed

- The HTML projection accepts `padding` with one to four lengths and
  `margin` with one to four lengths or `auto` (never negative), unitless
  `0`, `line-height` with units, `letter-spacing`, `text-transform`,
  `white-space`, `min-width` and `min-height`. Email buttons
  (`padding:12px 24px`) and centred blocks (`margin:0 auto`) keep their
  shape.
- A hidden image's alt text is styled (12 px, grey), so it stays readable
  inside the `font-size:0` cells email templates use.

### Added

- Tracking pixels (0-2 px images, by attribute or inline style) are removed
  from both projections and never counted as external images.
- CSS background images (`background-image`, or `background:` shorthand
  with `url()`) pass the external-image gate: counted while hidden, shown
  only in the external projection and only for public https hosts; the
  shorthand keeps its colour, `no-repeat`, `cover`/`contain` and `center`.
- Reader: after showing images, "Always show from <domain>" remembers the
  sender's domain on this browser (localStorage, at most 200).

## [0.59] - 2026-10-08

One public contact: the owner's own address on the product domain.

### Changed

- Support, security, privacy, refund and terms contacts, the page CTAs, the
  `auth.md` guide and `/.well-known/security.txt` use jean@mepmail.dev
  instead of the former je4ndev.com addresses (jean@, support@, privacy@,
  security@).

## [0.58] - 2026-10-08

Recipients as chips with suggested contacts in the Correio composer.

### Added

- `MailboxRecipientField` for To and Cc: a comma, semicolon, Enter, Tab,
  a space after a complete address or leaving the field closes a chip; a
  pasted list is split at once; Backspace on an empty field (or a double
  click) takes a chip back to edit; Enter never submits from it, and Escape
  closes the suggestions, not the composer. ARIA combobox with a listbox.
- `lib/mailbox-recipients.ts`: address extraction ("Name <a@b>", mailto:),
  splitting, case-insensitive merge, the same email rule as the server's
  `z.email()` (tested against it), contact ranking and matching.
- Suggestions from recipients used on this browser (localStorage, at most
  100), the Sent and Inbox lists (blocked items and no-reply senders left
  out), without the sending mailbox.
- A visible "+ Cc" next to To. Saving checks the chips first: an invalid
  address is named and focused, and To + Cc over 20 is refused.

### Changed

- From, To and Cc each take a full row in the composer.
- Composer errors replace the footer hint, so they show without scrolling.

### Fixed

- The hourly `tenants.sync` skips suspended teams and failed domain rows. It
  used to create their SES tenant again (the first provisioning step) before
  failing on the deleted identity, undoing what a suspension removes.

## [0.57] - 2026-10-08

Reply all, Cc and reply quoting in Correio.

### Added

- Cc on Correio drafts: `mailboxes.saveDraft` and `/api/mailbox-agent/drafts`
  take an optional `cc` list (the agent route stays strict), written to the
  MIME `Cc` header; To and Cc together are capped at the transport's 20
  recipients. The reader DTO exposes `cc`.
- Reply all in the reader (when the original had more than one recipient):
  To is the reply address and Cc everyone else on the original's To and Cc,
  without this mailbox or duplicates.
- Replies start with the original quoted as `> ` lines under an
  "On <date>, <sender> wrote:" line, below the managed signature footer, so
  the HTML part renders it as a quote block.
- The MCP `mailbox_save_draft` tool takes `cc` (at most 19).
- Agent drafts get the mailbox's managed signature footer appended once
  (not when the text already carries it), and so its formatted HTML.

### Changed

- `projectMailboxHtml` accepts a trusted image prefix: https images under our
  own public storage (`publicStoragePrefix()`, e.g. signature logos) show
  without the external-images prompt, and the reader's CSP `img-src` allows
  that origin. Shown images keep a plain pixel `width`/`height`.
- On phones the Correio app bar is one compact row: icon-only folder menu,
  no service badge, a short "Back" link.

### Fixed

- Replying no longer retains the original's attachments; only forwarding
  and editing a draft keep them.

## [0.56] - 2026-10-08

Professional email signatures in Correio.

### Added

- Mailbox migration 0015: `mailboxes.signature_profile` (jsonb, checked as an
  object of at most 2 KB): name, title, company, phone, website, logo URL and
  its pixel size. `signature_text` stays as the free-text lines.
- `updateMailboxSignature` (mailbox owner or team admin; phone digits and
  `+()-. ` only; website normalized to an http(s) URL without credentials)
  and the `mailboxes.updateSignature` procedure, audited as
  `mailbox.updated`.
- `/api/mailbox-signature-logo`: POST/DELETE for the owner or an admin,
  checked before storage. PNG or JPEG bytes only (the browser re-encodes to
  PNG at most 480x200), at most 512 KB, stored at
  `signature-logos/<teamId>/<mailboxId>.<ext>` with a cache-buster; the pixel
  size is read from the bytes for explicit width/height in mail.
- `apps/web/src/lib/mailbox-signature.ts`: the text signature, the
  email-safe HTML signature (one inline-styled table, logo behind an accent
  rule, tel: and website links, everything escaped), text-to-HTML for bodies
  (paragraphs, links, quote blocks) and `mailboxDraftHtml`.
- Correio drafts are multipart/alternative: the typed text plus an HTML part
  rebuilt on every save, where the composer's managed signature footer
  becomes the formatted signature; an edited footer stays text.
- Signature dialog in Correio settings with a live, sandboxed preview and the
  text version; the old admin-only signature field leaves the registry
  dialog.

## [0.55] - 2026-10-08

Read state, Archive and drag-and-drop in Correio.

### Added

- Mailbox migration 0014: `mailbox_items.seen_at` (existing rows backfilled
  as read at their `created_at`) and `archived_at`, with partial indexes for
  the unread Inbox and the Archive view.
- `setMailboxItemSeen`: owner-only read state for received mail. It never
  bumps `revision` or `updatedAt`, so open editors, approvals and list order
  are untouched. `countUnreadMailboxItems` and the `mailboxes.unreadCounts`
  query feed the Inbox badge and the "(n)" tab title.
- `setMailboxItemArchive` and the Archive folder (`folder: "archive"`):
  archiving clears `folderId`; filing an archived message un-archives it;
  drafts, Trash and Spam are not archived. Activity
  `mailbox.item_archived` / `mailbox.item_unarchived`.
- Drag-and-drop of rows (the checked set when the dragged row is checked)
  onto Inbox, Favorites, Archive, Spam, Trash and named folders; each row
  gets the one change the target means for it.
- Bulk actions on checked rows: archive (or back to Inbox), mark read,
  mark unread, trash.

### Changed

- `getMailboxContentList` orders rows by arrival (`createdAt`; drafts by
  `updatedAt`), so starring, filing or archiving no longer reorders the list.

### Fixed

- `api-key-auth` test: its billing period was fixed dates that expired on
  2026-10-01; it now spans the current date.

## [0.54] - 2026-10-08

A cleaner Correio inbox.

### Changed

- List rows: sender and date, subject, one preview line. The "Personal
  mailbox" chip is gone; the mailbox address shows only when rows of several
  mailboxes are mixed; attachments show as a paperclip; the star sits on the
  row's right edge, outside the open button.
- `mailboxPreview` builds the list snippet: it drops the `[https://…]` and
  `<https://…>` targets HTML-only mail carries as text, bare URLs and invisible
  preheader padding, and collapses whitespace.
- `mailboxListDate`: the time today, "yesterday", the weekday within the
  week, day and month this year, a short date before.
- Reader toolbar: Reply and Forward first; move to folder ("Move to folder…" /
  "Remove from folder"), star, spam and trash as icons with labels on the
  right; two rows on a phone. "Reply as draft" reads "Reply"; "Create email"
  reads "New mailbox" and leaves the phone app bar.
- The open message's frame fills the reader, so a long email scrolls once.
- Public site: while new subscriptions are paused, the launch announcement
  strip is not shown; the header's agent-ready badge stays hidden while the
  Correio "New" pill is in the nav (together they overflowed the 1200px
  header and the badge covered the first link).

### Fixed

- pt-BR: the system license badge read "Conta System".

## [0.53] - 2026-10-08

Clear rules against scams.

### Changed

- Terms of Service, section 3: impersonating a person, brand or institution
  (look-alike domains included), registering domains the account does not
  control, and switching sender, domain or account to escape blocks are named
  as prohibited.
- Terms of Service, section 8: signs of phishing or fraud allow an immediate
  suspension without notice, even before the first send; the suspension
  revokes API/SMTP keys and integration access, removes the domains from
  sending and cancels queued mail. Such accounts get no refund and chargebacks
  are disputed.
- Refund Policy, sections 2 and 6: the 7-day guarantee does not apply to
  accounts suspended for abuse.

### Fixed

- A suspension retries the SES identity delete for a few seconds: right after
  the tenant is deleted, SES can still refuse it.

## [0.52] - 2026-10-07

Sign-in and sign-up screens.

### Changed

- `AuthScreen` takes `panel` (login | signup): each screen has its own pitch
  beside the form; sign-up lists three reasons and shows a "free to start"
  note under the headline on every screen size.
- `AuthArt` draws the personalization illustration in HTML from the page's
  messages instead of an English-only picture (no 960px webp download).
- The AGPL source link left the auth form; the offer stays in the site
  footer, the dashboard sidebar and `/source`.
- The site header hides the agent-ready badge when signed in: the wider
  account side shrank the brand group and the badge slid over the nav.

## [0.51] - 2026-10-07

Front-end QA pass: phones and the legal pages.

### Fixed

- `messages/*/legal.json` had been saved as double-encoded UTF-8 (pt-BR 74
  strings, en 11): Terms, Privacy and Refund showed "PolÃ­tica", "Ãšltima".
- The public template gallery renders merge tokens as a reader sees them
  (`previewMergeTokens`: fallback, sample value, or the name).
- The hero offer's arrow no longer wraps onto its own line.

### Changed

- Ad-measurement banner on phones: about a third of the screen (was 52%),
  choices side by side, the no-choice-yet status line hidden.
- Footer links get finger-sized rows on phones; the sign-up updates
  checkbox is 18px and styled; 9–10.5px badges raised to 11px.

## [0.50] - 2026-10-07

Keeping the platform's own mail flowing while SES is paused.

### Added

- `SMTP_FALLBACK_URL`: while SES has paused the account, the worker sends
  the platform's own mail (system-team domains and the shared onboarding
  sender) through this SMTP relay; customer domains keep parking.
- `system.sendingPaused` and a dashboard strip on every page while SES has
  paused sending in a served region.

## [0.49] - 2026-10-07

Sending protection after the 2026-10-07 SES pause (three week-old accounts
sent phishing from fresh domains).

### Added

- `screenNewSender` (send-review): until an operator has reviewed a team once,
  a team in its probation days holds when a send would take it past the
  probation day's recipients; a young team holds on more than four sender
  addresses in 24 hours or on a sending domain under an abuse-prone TLD.
  Held mail is accepted and parked; reason `new_sender`.
- `holdReputationRuns`: a paused guardrail holds all of the team's mail,
  transactional included (reason `reputation`); its automatic flag becomes
  the review flag so the team stays listed while held.
- Impersonation lists cover French, Spanish and English-market banks,
  insurers, carriers and offices, and the lures of the 2026-10-07 runs.
- Migration 0048: `send_review_reason` gains `new_sender` and `reputation`.

### Changed

- The worker reads SES's enforcement status with the quota: while SES has
  paused the account (SHUTDOWN or sending disabled) mail parks as
  `queued_quota` instead of failing `ses_MessageRejected`, and the drain lets
  it out once sending resumes.

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
