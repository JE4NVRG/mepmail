import type { McpScope } from "./oauth-scopes.js";

/* Mirror of the tool registry in apps/api/src/mcp.ts — the API is the
   source of truth; apps/web/test/mcp-tools-sync.test.ts fails when they
   drift. Descriptions are copied verbatim from that registry so the settings
   page and the static MCP server card (/.well-known/mcp/server-card.json,
   read by Smithery and Glama) publish the tool surface a client actually
   sees.

   The registry lives here, not in the dashboard, because both apps serve the
   card: the dashboard on APP_BASE_URL and the API on its own origin (which is
   the origin a directory's scanner actually reads — see
   ./mcp-server-card.ts). */
export const MCP_TOOLS: {
  name: string;
  scope: McpScope;
  readOnly?: boolean;
  description: string;
}[] = [
  {
    name: "list_emails",
    scope: "emails:read",
    readOnly: true,
    description:
      "List the team's transactional emails (sent, queued and scheduled), oldest first, with cursor pagination.",
  },
  {
    name: "get_email",
    scope: "emails:read",
    readOnly: true,
    description:
      "Get one email by id: sender, recipients, subject, body, schedule and delivery status (last_event: queued, sent, delivered, bounced, complained, ...).",
  },
  {
    name: "get_email_insights",
    scope: "emails:read",
    readOnly: true,
    description:
      "Get the best-practice report for one email, computed when it was sent: per-check results (id, severity, pass/fail, points deducted) and a 0-10 score. The score measures compliance with sending best practices — it is NOT an inbox-placement probability. To improve it, fix what each failing check describes; never 'optimize' by disabling open/click tracking, removing unsubscribe links, or stripping legitimate content.",
  },
  {
    name: "get_deliverability",
    scope: "emails:read",
    readOnly: true,
    description:
      "Get the team's deliverability standing over the trailing 30 days: a 0-10 headline score with band, content and outcome sub-scores, complaint and hard-bounce rates, and guardrail status. The score measures best-practice compliance and recipient outcomes for the account — it is NOT an inbox-placement probability. Improve it by fixing per-email check failures (get_email_insights) and list hygiene, never by disabling tracking or stripping content.",
  },
  {
    name: "get_usage",
    scope: "emails:read",
    readOnly: true,
    description:
      "Get the team's plan and quota picture before bulk work: effective plan, its send limit (emails_per_day on Free and Starter, emails_per_month on Pro and Scale), domain limit and contact limit (`limits.contacts`, null when unlimited), emails accepted so far today (UTC) and when that counter resets, and on a monthly plan a `period` object with the billing period's emails_sent, included volume, whether overage is on and when the period ends. A self-hosted instance reports cloud=false with null plan, limits and period; the instance's own (system) team reports cloud=true with the same nulls.",
  },
  {
    name: "list_contacts",
    scope: "audience:read",
    readOnly: true,
    description:
      "List contacts of the team, oldest first, with cursor pagination. Pass segment_id to list only that segment's members; include=properties,topics attaches the typed property map and the topic subscriptions to every item.",
  },
  {
    name: "get_contact",
    scope: "audience:read",
    readOnly: true,
    description:
      "Get one contact by id or email, including custom properties and global unsubscribe state.",
  },
  {
    name: "get_contact_topics",
    scope: "audience:read",
    readOnly: true,
    description:
      "List every topic of the team with the contact's effective subscription (their explicit choice, else the topic's default) and whether it was explicit.",
  },
  {
    name: "list_segments",
    scope: "audience:read",
    readOnly: true,
    description:
      "List segments (saved audience filters or manual contact lists) — the targets broadcasts are sent to.",
  },
  {
    name: "get_segment",
    scope: "audience:read",
    readOnly: true,
    description:
      "Get one segment: its name and filter, or manual membership when it has no filter.",
  },
  {
    name: "list_topics",
    scope: "audience:read",
    readOnly: true,
    description:
      "List subscription topics (newsletter, product updates, ...) contacts can opt in or out of; topic ids scope sends and broadcasts.",
  },
  {
    name: "get_topic",
    scope: "audience:read",
    readOnly: true,
    description: "Get one subscription topic: name, description, default and visibility.",
  },
  {
    name: "list_contact_properties",
    scope: "audience:read",
    readOnly: true,
    description:
      "List the custom contact property definitions (key, type, fallback) usable on contacts and in templates.",
  },
  {
    name: "list_suppressions",
    scope: "audience:read",
    readOnly: true,
    description:
      "List suppressed addresses — bounces, complaints and manual blocks that every send skips, plus unsubscribes that block topic sends and broadcasts only — oldest first, with cursor pagination. Pass origin to see one kind. Addresses erased for GDPR/LGPD are hidden here and reachable by id only.",
  },
  {
    name: "get_suppression",
    scope: "audience:read",
    readOnly: true,
    description:
      "Get one suppression by id or email address: its origin and the email that caused it.",
  },
  {
    name: "list_broadcasts",
    scope: "broadcasts:read",
    readOnly: true,
    description: "List broadcasts with their status (draft, scheduled, sending, sent).",
  },
  {
    name: "get_broadcast",
    scope: "broadcasts:read",
    readOnly: true,
    description: "Get one broadcast: audience, content, schedule and status.",
  },
  {
    name: "list_templates",
    scope: "templates:read",
    readOnly: true,
    description:
      "List email templates (name, alias, timestamps), oldest first, with cursor pagination.",
  },
  {
    name: "get_template",
    scope: "templates:read",
    readOnly: true,
    description:
      "Get one template by id or alias, including its subject, html and text. Every save is live: there is no draft/publish cycle.",
  },
  {
    name: "list_webhooks",
    scope: "webhooks:write",
    readOnly: true,
    description:
      "List webhook endpoints with their subscribed events and status (list rows never carry signing secrets).",
  },
  {
    name: "get_webhook",
    scope: "webhooks:write",
    readOnly: true,
    description:
      "Get one webhook endpoint by id, including its Standard Webhooks signing secret (whsec_…).",
  },
  {
    name: "list_api_keys",
    scope: "api-keys:write",
    readOnly: true,
    description:
      "List the team's active API keys: name, creation and last-used times. Tokens are never returned; a lost token means a new key.",
  },
  {
    name: "list_domains",
    scope: "domains:read",
    readOnly: true,
    description:
      "List sending domains with verification status. Emails can only be sent from a verified domain.",
  },
  {
    name: "get_domain",
    scope: "domains:read",
    readOnly: true,
    description:
      "Get one sending domain with its DNS records (DKIM, MAIL FROM, DMARC, and the Tracking CNAME once a tracking subdomain is set) and per-record status. Only the DKIM and MAIL FROM (SPF) rows gate sending. The DMARC row is recommended, and reads verified when a parent-domain policy covers the subdomain (see inherited_from and policy). Each record's live field says what public DNS answers now; detail explains a pending or failed row.",
  },
  {
    name: "send_email",
    scope: "emails:send",
    description:
      "Send a transactional email (or schedule it with scheduled_at). Suppressed and topic-opted-out recipients are skipped automatically. Returns the email id.",
  },
  {
    name: "send_email_batch",
    scope: "emails:send",
    description:
      "Send up to 100 emails in one call; each entry has the same shape as send_email. Returns one id per accepted email.",
  },
  {
    name: "update_email",
    scope: "emails:send",
    description: "Reschedule a scheduled email that has not been sent yet.",
  },
  {
    name: "cancel_email",
    scope: "emails:send",
    description: "Cancel a scheduled email before it is sent.",
  },
  {
    name: "create_contact",
    scope: "audience:write",
    description:
      "Create a contact in the team audience, optionally placing it in segments and setting topic subscriptions. Fails with 409 if the email already exists.",
  },
  {
    name: "create_contact_batch",
    scope: "audience:write",
    description:
      "Create up to 1000 contacts in one call — use this for imports instead of repeated create_contact calls. Each item has the same shape as create_contact. on_conflict decides what happens to an email that already belongs to a contact, or repeats inside the batch: error (default) counts it as a failed item, skip keeps the existing contact and reports its id, upsert merges names, properties, segments and topics into it (a batch never re-subscribes anyone). validation strict (default) is all-or-nothing: any failed item — invalid, conflicting, or naming an unknown segment or topic — rejects the whole batch with that item's status and nothing is written; permissive writes every item that succeeds and lists the failures in errors.",
  },
  {
    name: "update_contact",
    scope: "audience:write",
    description:
      "Update a contact's name, custom properties or global unsubscribe flag. Omitted fields are left unchanged.",
  },
  {
    name: "update_contact_topics",
    scope: "audience:write",
    description:
      "Set a contact's per-topic subscription choices. Topics not listed are left unchanged.",
  },
  {
    name: "delete_contact",
    scope: "audience:write",
    description:
      "Delete a contact and its segment memberships; its emails stay in the log. Pass erase=true to also scrub the address from email history, event payloads and API logs (GDPR/LGPD). This cannot be undone.",
  },
  {
    name: "delete_contacts",
    scope: "audience:write",
    description:
      "Delete up to 1000 contacts in one call, by ids or by email addresses (exactly one of the two). Returns the contacts actually deleted; unknown ones are skipped. Emails stay in the log; erase=true also scrubs each address from email history, like delete_contact. This cannot be undone.",
  },
  {
    name: "create_contact_preferences_link",
    scope: "audience:write",
    description:
      "Mint the hosted preference-center URL for a contact (by id or email): the page their unsubscribe links open, listing the team's public topics with a global unsubscribe. The link never expires and lets its holder change that contact's preferences, so hand it only to the contact.",
  },
  {
    name: "add_contact_to_segment",
    scope: "audience:write",
    description: "Add a contact to a manual segment. Idempotent: adding twice is not an error.",
  },
  {
    name: "remove_contact_from_segment",
    scope: "audience:write",
    description: "Remove a contact from a manual segment. The contact itself is kept.",
  },
  {
    name: "create_segment",
    scope: "audience:write",
    description:
      "Create a segment. With a filter it selects contacts dynamically; without one it is a manual membership list fed by add_contact_to_segment.",
  },
  {
    name: "update_segment",
    scope: "audience:write",
    description:
      "Rename a segment or change its filter (null clears the filter, making it manual).",
  },
  {
    name: "delete_segment",
    scope: "audience:write",
    description: "Delete a segment. Its contacts remain in the audience.",
  },
  {
    name: "create_topic",
    scope: "audience:write",
    description:
      "Create a subscription topic (name, description, default_subscription, visibility). Topic ids scope sends and broadcasts.",
  },
  {
    name: "update_topic",
    scope: "audience:write",
    description:
      "Update a topic's name, description or visibility. The default subscription is immutable.",
  },
  {
    name: "delete_topic",
    scope: "audience:write",
    description: "Delete a subscription topic and the per-contact choices recorded for it.",
  },
  {
    name: "create_contact_property",
    scope: "audience:write",
    description: "Define a custom contact property (key, type, optional fallback value).",
  },
  {
    name: "update_contact_property",
    scope: "audience:write",
    description: "Update a custom contact property definition.",
  },
  {
    name: "delete_contact_property",
    scope: "audience:write",
    description: "Delete a custom contact property definition.",
  },
  {
    name: "add_suppressions",
    scope: "audience:write",
    description:
      "Block up to 1000 addresses in one call. origin (default manual) is recorded on rows this call creates: bounce, complaint and manual block every send; unsubscribe (a migrated opt-out list) blocks topic sends and broadcasts only, so topic-less POST /emails still delivers. An address already suppressed keeps its origin and reports its existing id.",
  },
  {
    name: "remove_suppressions",
    scope: "audience:write",
    description:
      "Unblock up to 1000 addresses in one call, by emails or by ids (exactly one of the two). Returns only the rows actually removed.",
  },
  {
    name: "delete_suppression",
    scope: "audience:write",
    description:
      "Remove one suppression by id or email address; the address can receive email again.",
  },
  {
    name: "create_broadcast",
    scope: "broadcasts:write",
    description:
      "Create a broadcast (bulk email to a segment or the whole audience). Saved as a draft unless send is true; use send_broadcast to send a draft later. A large audience is paced over days; the response's finishes_at and warning say when it finishes.",
  },
  {
    name: "update_broadcast",
    scope: "broadcasts:write",
    description: "Update a draft broadcast's audience, content or subject.",
  },
  {
    name: "send_broadcast",
    scope: "broadcasts:write",
    description:
      "Send a draft broadcast now, or schedule it with scheduled_at. Recipients are resolved at send time; unsubscribed and topic-opted-out contacts are skipped. A large audience is paced over days; the response's finishes_at and warning say when it finishes.",
  },
  {
    name: "cancel_broadcast",
    scope: "broadcasts:write",
    description:
      "Cancels a queued broadcast. Emails already sent are not recalled: check sent_count first; canceled_remaining says how many were stopped.",
  },
  {
    name: "delete_broadcast",
    scope: "broadcasts:write",
    description: "Delete a draft broadcast. Sent broadcasts cannot be deleted.",
  },
  {
    name: "create_template",
    scope: "templates:write",
    description:
      "Create an email template: name, html, optional subject, text and alias (a stable handle, unique per team). Live immediately. A template created with html opens in the dashboard's code mode and keeps its HTML byte for byte; converting it to blocks is the user's explicit choice there. from, reply_to and variables are not supported yet; passing them is a 422.",
  },
  {
    name: "update_template",
    scope: "templates:write",
    description:
      "Change a template's name, subject, html, text or alias (null clears the alias). Omitted fields are left unchanged; the change is live immediately. Writing html makes the template html-authored: it opens in the dashboard's code mode and keeps its HTML byte for byte; converting it to blocks is the user's explicit choice there.",
  },
  {
    name: "delete_template",
    scope: "templates:write",
    description:
      "Delete a template. Broadcasts keep their own copy of its content. This cannot be undone.",
  },
  {
    name: "create_webhook",
    scope: "webhooks:write",
    description:
      "Create a webhook endpoint subscribed to email events. The response includes the Standard Webhooks signing secret (whsec_…) used to verify deliveries — store it; it is also retrievable via get_webhook.",
  },
  {
    name: "update_webhook",
    scope: "webhooks:write",
    description: "Update a webhook's endpoint URL, subscribed events, or enabled/disabled status.",
  },
  {
    name: "rotate_webhook_secret",
    scope: "webhooks:write",
    description:
      "Rotate a webhook's signing secret. Returns the new whsec_ secret; the previous one keeps signing alongside it for overlap_hours (default 24, up to 72) so the receiver can switch without a gap. Pass signing_secret to bring your own.",
  },
  {
    name: "delete_webhook",
    scope: "webhooks:write",
    description: "Delete a webhook endpoint. Deliveries to it stop immediately.",
  },
  {
    name: "create_api_key",
    scope: "api-keys:write",
    description:
      "Create an API key for REST and SDK access. The token is returned only in this response and never again: hand it to the caller or store it at once, and treat it as a secret. permission is full_access (default) or sending_access; domain_id restricts a key to one verified domain.",
  },
  {
    name: "revoke_api_key",
    scope: "api-keys:write",
    description: "Revoke an API key. Requests carrying it fail from now on; this cannot be undone.",
  },
  {
    name: "create_domain",
    scope: "domains:write",
    description:
      "Add a sending domain. A domain has one region; to move it, delete and re-add it. Returns the DNS records to create; the domain sends once they verify. Open and click tracking start off; pass open_tracking/click_tracking together with a tracking_subdomain to stand the domain up tracked in one call — its Tracking CNAME then comes back with the other records (same rules as update_domain).",
  },
  {
    name: "update_domain",
    scope: "domains:write",
    description:
      "Change a domain's open/click tracking. Tracking is served from the domain's own tracking subdomain: pass tracking_subdomain (a label such as \"links\") and the returned records include its CNAME; links are tracked through it once that CNAME resolves (re-check with verify_domain). On MepMail Cloud, turning tracking on without a subdomain is refused.",
  },
  {
    name: "verify_domain",
    scope: "domains:write",
    description:
      "Re-check a domain's DNS records and SES verification, returning the domain with fresh per-record status. Only the DKIM and MAIL FROM (SPF) rows gate sending. The DMARC row is recommended, and reads verified when a parent-domain policy covers the subdomain (see inherited_from and policy). Each record's live field says what public DNS answers now; detail explains a pending or failed row.",
  },
  {
    name: "delete_domain",
    scope: "domains:write",
    description:
      "Remove a sending domain and its SES identity. Sends from it stop immediately; this cannot be undone.",
  },
];
