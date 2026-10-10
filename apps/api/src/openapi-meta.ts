/**
 * Metadata the route definitions do not carry, applied to the published
 * OpenAPI document: an operationId, a summary and a one-line description per
 * operation, tags, the bearer scheme, and the 401/429 answers every
 * authenticated route can give. The docs build renders one page per operation
 * from this document, so the summary is the page title and the description its
 * meta description. Keys are "METHOD /path" as registered; a test fails when a
 * route is added without an entry here.
 */

const TAGS = {
  emails: { name: "Emails", description: "Send, schedule, read and cancel emails." },
  contacts: { name: "Contacts", description: "The people you send to, their topics and segments." },
  audiences: {
    name: "Audiences",
    description: "Resend's audience-scoped contact routes, kept for SDK compatibility.",
  },
  contactProperties: {
    name: "Contact properties",
    description: "Custom fields stored on every contact.",
  },
  segments: { name: "Segments", description: "Saved contact filters for broadcasts." },
  broadcasts: { name: "Broadcasts", description: "One email to a whole segment." },
  topics: { name: "Topics", description: "Subscription topics contacts can opt in and out of." },
  domains: { name: "Domains", description: "Sending domains and their DNS records." },
  apiKeys: { name: "API keys", description: "Keys that authenticate API calls." },
  webhooks: { name: "Webhooks", description: "Signed event deliveries to your endpoints." },
  suppressions: {
    name: "Suppressions",
    description: "Addresses MepMail will not send to (bounces, complaints, unsubscribes).",
  },
  templates: { name: "Templates", description: "Reusable email content." },
  account: { name: "Account", description: "Plan, usage and deliverability of the team." },
} as const;

type TagKey = keyof typeof TAGS;

interface OperationMeta {
  id: string;
  tag: TagKey;
  summary: string;
  /** Used only when the route defines no description of its own. */
  description: string;
}

const op = (id: string, tag: TagKey, summary: string, description: string): OperationMeta => ({
  id,
  tag,
  summary,
  description,
});

export const OPERATION_META: Readonly<Record<string, OperationMeta>> = {
  "POST /emails": op(
    "sendEmail",
    "emails",
    "Send an email",
    "Queues one email for delivery, now or at scheduled_at, from a verified domain of the team.",
  ),
  "GET /emails": op(
    "listEmails",
    "emails",
    "List emails",
    "Lists the team's sent and scheduled emails, newest first, one page at a time.",
  ),
  "POST /emails/batch": op(
    "sendEmailBatch",
    "emails",
    "Send a batch of emails",
    "Queues up to 100 different emails in one request; each item is a send request.",
  ),
  "GET /emails/{id}": op(
    "getEmail",
    "emails",
    "Retrieve an email",
    "Returns one email with its recipients, content and last delivery event.",
  ),
  "PATCH /emails/{id}": op(
    "updateEmail",
    "emails",
    "Reschedule an email",
    "Moves a scheduled email to a new scheduled_at before it is sent.",
  ),
  "DELETE /emails/{id}": op(
    "deleteEmail",
    "emails",
    "Delete an email",
    "Deletes an email and its events from the log.",
  ),
  "POST /emails/{id}/cancel": op(
    "cancelEmail",
    "emails",
    "Cancel a scheduled email",
    "Cancels an email that is still scheduled, so it is never sent.",
  ),
  "GET /emails/{id}/insights": op(
    "getEmailInsights",
    "emails",
    "Get email insights",
    "Returns the best-practice checks and the score computed when the email was sent.",
  ),
  "POST /contacts": op(
    "createContact",
    "contacts",
    "Create a contact",
    "Creates a contact with its properties, topic subscriptions and segments.",
  ),
  "GET /contacts": op(
    "listContacts",
    "contacts",
    "List contacts",
    "Lists the team's contacts one page at a time.",
  ),
  "POST /contacts/batch": op(
    "createContactsBatch",
    "contacts",
    "Create contacts in bulk",
    "Creates up to 1,000 contacts in one request.",
  ),
  "POST /contacts/batch/get": op(
    "getContactsBatch",
    "contacts",
    "Read contacts in bulk",
    "Returns up to 1,000 contacts by id or email address in one request.",
  ),
  "POST /contacts/batch/remove": op(
    "removeContactsBatch",
    "contacts",
    "Delete contacts in bulk",
    "Deletes up to 1,000 contacts by id or email address in one request.",
  ),
  "GET /contacts/{id}": op(
    "getContact",
    "contacts",
    "Retrieve a contact",
    "Returns one contact by id or email address, with its properties.",
  ),
  "PATCH /contacts/{id}": op(
    "updateContact",
    "contacts",
    "Update a contact",
    "Updates a contact's name, properties or unsubscribed flag.",
  ),
  "DELETE /contacts/{id}": op(
    "deleteContact",
    "contacts",
    "Delete a contact",
    "Deletes a contact and its segment memberships.",
  ),
  "POST /contacts/{id}/preferences-link": op(
    "createContactPreferencesLink",
    "contacts",
    "Mint a preference-center link for a contact",
    "Returns the contact's hosted preferences URL.",
  ),
  "GET /contacts/{id}/topics": op(
    "listContactTopics",
    "contacts",
    "List a contact's topics",
    "Lists every topic of the team with the contact's effective subscription.",
  ),
  "PATCH /contacts/{id}/topics": op(
    "updateContactTopics",
    "contacts",
    "Update a contact's topics",
    "Opts a contact in or out of topics.",
  ),
  "POST /contacts/{id}/segments/{segmentId}": op(
    "addContactToSegment",
    "contacts",
    "Add a contact to a segment",
    "Adds a contact to a static segment.",
  ),
  "DELETE /contacts/{id}/segments/{segmentId}": op(
    "removeContactFromSegment",
    "contacts",
    "Remove a contact from a segment",
    "Removes a contact from a static segment.",
  ),
  "POST /audiences/{audienceId}/contacts": op(
    "createAudienceContact",
    "audiences",
    "Create a contact in an audience",
    "Resend-compatible route: creates a contact under an audience id.",
  ),
  "GET /audiences/{audienceId}/contacts/{id}": op(
    "getAudienceContact",
    "audiences",
    "Retrieve a contact in an audience",
    "Resend-compatible route: returns a contact under an audience id.",
  ),
  "PATCH /audiences/{audienceId}/contacts/{id}": op(
    "updateAudienceContact",
    "audiences",
    "Update a contact in an audience",
    "Resend-compatible route: updates a contact under an audience id.",
  ),
  "DELETE /audiences/{audienceId}/contacts/{id}": op(
    "deleteAudienceContact",
    "audiences",
    "Delete a contact in an audience",
    "Resend-compatible route: deletes a contact under an audience id.",
  ),
  "POST /contact-properties": op(
    "createContactProperty",
    "contactProperties",
    "Create a contact property",
    "Defines a custom field that every contact can carry.",
  ),
  "GET /contact-properties": op(
    "listContactProperties",
    "contactProperties",
    "List contact properties",
    "Lists the team's custom contact fields.",
  ),
  "GET /contact-properties/{id}": op(
    "getContactProperty",
    "contactProperties",
    "Retrieve a contact property",
    "Returns one custom contact field.",
  ),
  "PATCH /contact-properties/{id}": op(
    "updateContactProperty",
    "contactProperties",
    "Update a contact property",
    "Renames a custom contact field or changes its fallback value.",
  ),
  "DELETE /contact-properties/{id}": op(
    "deleteContactProperty",
    "contactProperties",
    "Delete a contact property",
    "Deletes a custom contact field and its values.",
  ),
  "POST /segments": op(
    "createSegment",
    "segments",
    "Create a segment",
    "Creates a segment of contacts for broadcasts.",
  ),
  "GET /segments": op("listSegments", "segments", "List segments", "Lists the team's segments."),
  "GET /segments/{id}": op(
    "getSegment",
    "segments",
    "Retrieve a segment",
    "Returns one segment and its filter.",
  ),
  "PATCH /segments/{id}": op(
    "updateSegment",
    "segments",
    "Update a segment",
    "Renames a segment or changes its filter.",
  ),
  "DELETE /segments/{id}": op(
    "deleteSegment",
    "segments",
    "Delete a segment",
    "Deletes a segment; its contacts stay.",
  ),
  "GET /segments/{id}/contacts": op(
    "listSegmentContacts",
    "segments",
    "List a segment's contacts",
    "Lists the contacts a segment resolves to right now.",
  ),
  "POST /broadcasts": op(
    "createBroadcast",
    "broadcasts",
    "Create a broadcast",
    "Creates a broadcast to a segment, and schedules it when send is true.",
  ),
  "GET /broadcasts": op(
    "listBroadcasts",
    "broadcasts",
    "List broadcasts",
    "Lists the team's broadcasts.",
  ),
  "GET /broadcasts/{id}": op(
    "getBroadcast",
    "broadcasts",
    "Retrieve a broadcast",
    "Returns one broadcast with its status and counts.",
  ),
  "PATCH /broadcasts/{id}": op(
    "updateBroadcast",
    "broadcasts",
    "Update a broadcast",
    "Changes a draft broadcast before it is sent.",
  ),
  "DELETE /broadcasts/{id}": op(
    "deleteBroadcast",
    "broadcasts",
    "Delete a broadcast",
    "Deletes a draft broadcast.",
  ),
  "POST /broadcasts/{id}/send": op(
    "sendBroadcast",
    "broadcasts",
    "Send a broadcast",
    "Schedules a broadcast now or at a later time.",
  ),
  "POST /broadcasts/{id}/cancel": op(
    "cancelBroadcast",
    "broadcasts",
    "Cancel a broadcast",
    "Cancels a scheduled broadcast before it goes out.",
  ),
  "POST /topics": op(
    "createTopic",
    "topics",
    "Create a topic",
    "Creates a subscription topic with its default opt-in.",
  ),
  "GET /topics": op("listTopics", "topics", "List topics", "Lists the team's topics."),
  "GET /topics/{id}": op("getTopic", "topics", "Retrieve a topic", "Returns one topic."),
  "PATCH /topics/{id}": op(
    "updateTopic",
    "topics",
    "Update a topic",
    "Renames a topic or changes its description or visibility.",
  ),
  "DELETE /topics/{id}": op("deleteTopic", "topics", "Delete a topic", "Deletes a topic."),
  "POST /domains": op(
    "createDomain",
    "domains",
    "Add a domain",
    "Adds a sending domain and returns the DNS records to publish.",
  ),
  "GET /domains": op("listDomains", "domains", "List domains", "Lists the team's domains."),
  "GET /domains/{id}": op(
    "getDomain",
    "domains",
    "Retrieve a domain",
    "Returns one domain with its DNS records and their status.",
  ),
  "PATCH /domains/{id}": op(
    "updateDomain",
    "domains",
    "Update a domain",
    "Changes a domain's click and open tracking or TLS policy.",
  ),
  "DELETE /domains/{id}": op(
    "deleteDomain",
    "domains",
    "Delete a domain",
    "Removes a sending domain from the team.",
  ),
  "POST /domains/{id}/verify": op(
    "verifyDomain",
    "domains",
    "Verify a domain",
    "Checks the domain's DNS records now and returns each record's status.",
  ),
  "POST /api-keys": op(
    "createApiKey",
    "apiKeys",
    "Create an API key",
    "Creates an API key; the token is returned only in this response.",
  ),
  "GET /api-keys": op(
    "listApiKeys",
    "apiKeys",
    "List API keys",
    "Lists the team's active API keys, never their tokens.",
  ),
  "DELETE /api-keys/{id}": op(
    "deleteApiKey",
    "apiKeys",
    "Revoke an API key",
    "Revokes an API key at once.",
  ),
  "POST /webhooks": op(
    "createWebhook",
    "webhooks",
    "Create a webhook",
    "Registers an endpoint for the chosen events and returns its signing secret.",
  ),
  "GET /webhooks": op("listWebhooks", "webhooks", "List webhooks", "Lists the team's webhooks."),
  "GET /webhooks/{id}": op(
    "getWebhook",
    "webhooks",
    "Retrieve a webhook",
    "Returns one webhook, including its signing secret.",
  ),
  "PATCH /webhooks/{id}": op(
    "updateWebhook",
    "webhooks",
    "Update a webhook",
    "Changes a webhook's endpoint, events or status.",
  ),
  "DELETE /webhooks/{id}": op(
    "deleteWebhook",
    "webhooks",
    "Delete a webhook",
    "Deletes a webhook; nothing is delivered to it afterwards.",
  ),
  "POST /webhooks/{id}/rotate": op(
    "rotateWebhookSecret",
    "webhooks",
    "Rotate a webhook's signing secret",
    "Mints a new signing secret, optionally keeping the old one for an overlap.",
  ),
  "POST /suppressions": op(
    "createSuppression",
    "suppressions",
    "Suppress an address",
    "Blocks sending to one address.",
  ),
  "GET /suppressions": op(
    "listSuppressions",
    "suppressions",
    "List suppressions",
    "Lists suppressed addresses, optionally by origin.",
  ),
  "POST /suppressions/batch/add": op(
    "addSuppressionsBatch",
    "suppressions",
    "Suppress addresses in bulk",
    "Blocks up to 1,000 addresses in one request.",
  ),
  "POST /suppressions/batch/remove": op(
    "removeSuppressionsBatch",
    "suppressions",
    "Remove suppressions in bulk",
    "Unblocks up to 1,000 addresses or ids in one request.",
  ),
  "GET /suppressions/{id}": op(
    "getSuppression",
    "suppressions",
    "Retrieve a suppression",
    "Returns one suppression by id or email address.",
  ),
  "DELETE /suppressions/{id}": op(
    "deleteSuppression",
    "suppressions",
    "Remove a suppression",
    "Unblocks one address so it can receive mail again.",
  ),
  "POST /templates": op(
    "createTemplate",
    "templates",
    "Create a template",
    "Creates a reusable email template; every save is live.",
  ),
  "GET /templates": op(
    "listTemplates",
    "templates",
    "List templates",
    "Lists the team's templates.",
  ),
  "GET /templates/{id}": op(
    "getTemplate",
    "templates",
    "Retrieve a template",
    "Returns one template by id or alias.",
  ),
  "PATCH /templates/{id}": op(
    "updateTemplate",
    "templates",
    "Update a template",
    "Changes a template; the change is live immediately.",
  ),
  "DELETE /templates/{id}": op(
    "deleteTemplate",
    "templates",
    "Delete a template",
    "Deletes a template; broadcasts keep their own copy.",
  ),
  "POST /templates/{id}/publish": op(
    "publishTemplate",
    "templates",
    "Publish a template",
    "Kept for SDK compatibility: templates are always published.",
  ),
  "POST /templates/{id}/duplicate": op(
    "duplicateTemplate",
    "templates",
    "Duplicate a template",
    "Copies a template under a new id.",
  ),
  "GET /usage": op(
    "getUsage",
    "account",
    "Get plan and usage",
    "Returns the team's plan, limits and usage in the current period.",
  ),
  "GET /deliverability": op(
    "getDeliverability",
    "account",
    "Get the deliverability score",
    "Returns the account's deliverability score over the trailing 30 days.",
  ),
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const ERROR_SCHEMA = { $ref: "#/components/schemas/ErrorResponse" };
const RETRY_AFTER = {
  description: "Seconds to wait before retrying.",
  schema: { type: "integer", minimum: 1 },
};
const UNAUTHORIZED = {
  description: "Missing, malformed or invalid API key",
  content: { "application/json": { schema: ERROR_SCHEMA } },
};
const RATE_LIMITED = {
  description:
    "Rate limit exceeded: 600 requests per minute per API key and 3,000 per team; wait for Retry-After",
  headers: { "Retry-After": RETRY_AFTER },
  content: { "application/json": { schema: ERROR_SCHEMA } },
};

const SEND_EXAMPLE = {
  from: "Acme <hello@yourdomain.com>",
  to: ["customer@example.com"],
  subject: "Your order has shipped",
  html: "<p>Your order is on its way.</p>",
};

const EXAMPLES: Readonly<Record<string, { request?: unknown; response?: unknown }>> = {
  "POST /emails": {
    request: SEND_EXAMPLE,
    response: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
  },
  "POST /emails/batch": {
    request: [SEND_EXAMPLE, { ...SEND_EXAMPLE, to: ["another@example.com"] }],
    response: {
      data: [
        { id: "ae2014de-c168-4c61-8267-70d2662a1ce1" },
        { id: "faccb7a5-8a28-4e9a-ac64-8da1cc3bc1cb" },
      ],
    },
  },
  "POST /contacts": {
    request: { email: "customer@example.com", first_name: "Ana", last_name: "Silva" },
  },
  "POST /domains": { request: { name: "mail.yourdomain.com" } },
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setJsonExample(container: unknown, example: unknown) {
  if (!isObject(container) || !isObject(container.content)) return;
  const media = container.content["application/json"];
  if (isObject(media) && media.example === undefined) media.example = example;
}

/** Applies OPERATION_META, tags, the bearer scheme, 401/429 answers and examples in place. */
export function enrichOpenApiDocument<T extends JsonObject>(doc: T): T {
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const meta = OPERATION_META[key];
      if (meta) {
        operation.operationId = meta.id;
        operation.summary ??= meta.summary;
        operation.tags = [TAGS[meta.tag].name];
        if (typeof operation.description !== "string" || !operation.description.trim())
          operation.description = meta.description;
      }
      const responses = isObject(operation.responses) ? operation.responses : {};
      operation.responses = responses;
      responses["401"] ??= UNAUTHORIZED;
      const existing = responses["429"];
      responses["429"] = isObject(existing)
        ? {
            ...existing,
            description: `${String(existing.description ?? "Too many requests")}, or the rate limit was exceeded (see Retry-After)`,
            headers: {
              ...(isObject(existing.headers) ? existing.headers : {}),
              "Retry-After": RETRY_AFTER,
            },
          }
        : RATE_LIMITED;
      const examples = EXAMPLES[key];
      if (examples?.request !== undefined) setJsonExample(operation.requestBody, examples.request);
      if (examples?.response !== undefined) setJsonExample(responses["200"], examples.response);
    }
  }
  const components = isObject(doc.components) ? doc.components : {};
  (doc as JsonObject).components = components;
  components.securitySchemes = {
    ...(isObject(components.securitySchemes) ? components.securitySchemes : {}),
    apiKey: {
      type: "http",
      scheme: "bearer",
      description:
        "An API key from the dashboard (ms_…), sent as Authorization: Bearer. A sending-only key reaches the /emails routes only.",
    },
  };
  (doc as JsonObject).security = [{ apiKey: [] }];
  (doc as JsonObject).tags = Object.values(TAGS).map((tag) => ({ ...tag }));
  return doc;
}
