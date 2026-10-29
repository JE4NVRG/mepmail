import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** This pilot is bound to our ACS resource, never a caller-selected tenant. */
export const AZURE_EMAIL_SOURCE =
  "/subscriptions/4881e023-287d-4b1e-90ce-e643ee354ba5/resourceGroups/mepmail-email/providers/Microsoft.Communication/communicationServices/mepmail-acs";
export const AZURE_EVENT_MAX_BYTES = 65_536;
const DELIVERY = "Microsoft.Communication.EmailDeliveryReportReceived";
const VALIDATION = "Microsoft.EventGrid.SubscriptionValidationEvent";
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@+-]+$/);
const timestamp = z.iso.datetime({ offset: true });
const envelope = z.object({
  id: identifier,
  topic: z.string().max(1024),
  eventType: z.string().max(128),
  eventTime: timestamp,
  dataVersion: z.string().max(16),
  metadataVersion: z.literal("1"),
  data: z.unknown(),
});
const statuses = {
  Delivered: "delivered",
  Bounced: "hard_bounce",
  Suppressed: "suppressed",
  Quarantined: "quarantined",
  FilteredSpam: "filtered_spam",
  Expanded: "expanded",
  Failed: "failed",
} as const;
const delivery = z.object({
  messageId: identifier,
  recipient: z.email().max(254),
  status: z.enum([
    "Delivered",
    "Bounced",
    "Suppressed",
    "Quarantined",
    "FilteredSpam",
    "Expanded",
    "Failed",
  ]),
  deliveryAttemptTimeStamp: timestamp,
});
const configuration = z.object({
  token: z
    .string()
    .min(32)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  topic: z.string(),
  teamId: z.uuid(),
  subscription: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  recipients: z.array(z.email().max(254)).min(1).max(20),
});
export type AzureEventConfig = z.infer<typeof configuration>;
export interface AzureDeliveryAudit {
  provider: "azure";
  messageId: string;
  eventId: string;
  status: (typeof statuses)[keyof typeof statuses];
  recipientHash: string;
  eventTime: string;
  deliveryAttemptTime: string;
}
export interface AzureEventStore {
  /** Must commit the entire batch atomically; conflicting existing IDs reject it. */
  append(teamId: string, events: AzureDeliveryAudit[]): Promise<void>;
}
export class AzureEventConflict extends Error {}

/** Lazy, fail-closed: no new build-time or globally required env keys. */
export function readAzureEventConfig(env: NodeJS.ProcessEnv): AzureEventConfig | null {
  const parsed = configuration.safeParse({
    token: env.AZURE_EMAIL_EVENT_TOKEN,
    topic: env.AZURE_EMAIL_EVENT_TOPIC,
    teamId: env.AZURE_EMAIL_EVENT_TEAM_ID,
    subscription: env.AZURE_EMAIL_EVENT_SUBSCRIPTION,
    recipients: env.AZURE_EMAIL_EVENT_ALLOWED_RECIPIENTS?.split(",").map((s) =>
      s.trim().toLowerCase(),
    ),
  });
  if (!parsed.success || parsed.data.topic.toLowerCase() !== AZURE_EMAIL_SOURCE.toLowerCase()) {
    return null;
  }
  return parsed.data;
}

function authorized(actual: string | null, expected: string): boolean {
  if (!actual || actual.length > 4096) return false;
  // Fixed-size digests avoid a length-dependent compare (and never emit either value).
  return timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function recent(value: string, now: number): boolean {
  const time = Date.parse(value);
  // Event Grid retries for up to 24 hours; allow bounded clock/transport skew.
  return Number.isFinite(time) && time >= now - 26 * 3_600_000 && time <= now + 300_000;
}

async function readBody(request: Request): Promise<unknown> {
  const size = request.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > AZURE_EVENT_MAX_BYTES)) {
    throw new RangeError();
  }
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > AZURE_EVENT_MAX_BYTES) {
        await reader.cancel();
        throw new RangeError();
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    reader.releaseLock();
  }
}

/** No network, mail sends, customer mutation, suppression writes, or untrusted logs. */
export async function handleAzureEmailEvents(
  request: Request,
  dependencies: {
    env: NodeJS.ProcessEnv;
    store: () => AzureEventStore;
    now?: () => number;
  },
): Promise<Response> {
  const config = readAzureEventConfig(dependencies.env);
  const reply = (status: number) => new Response(null, { status });
  if (!config) return reply(503);
  // Credentials belong only in the dedicated header, never URL/query parameters.
  if (new URL(request.url).search) return reply(400);
  if (request.headers.get("aeg-subscription-name") !== config.subscription) return reply(403);
  const kind = request.headers.get("aeg-event-type");
  if (kind !== "Notification" && kind !== "SubscriptionValidation") return reply(400);
  const token = request.headers.get("x-mepmail-azure-event-token");
  // Provisioning and delivery both authenticate with the same exclusive header.
  // Never anonymously echo a challenge if Azure does not deliver that header.
  if (!authorized(token, config.token)) return reply(401);
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return reply(415);
  }
  let raw: unknown;
  try {
    raw = await readBody(request);
  } catch (error) {
    return reply(error instanceof RangeError ? 413 : 400);
  }
  const parsed = z.array(envelope).min(1).max(50).safeParse(raw);
  if (!parsed.success) return reply(400);
  const now = dependencies.now?.() ?? Date.now();
  for (const event of parsed.data) {
    // Delivery reports carry the ACS source. Provisioning metadata is NOT a
    // delivery authorization boundary: its topic may differ in Azure's live
    // handshake. Both still require the exclusive token + exact subscription;
    // validation is singleton/code-only, performs no persistence or URL fetch.
    if (kind === "Notification" && event.topic.toLowerCase() !== config.topic.toLowerCase()) {
      return reply(403);
    }
    if (!recent(event.eventTime, now)) return reply(400);
  }
  if (kind === "SubscriptionValidation") {
    const event = parsed.data[0];
    if (parsed.data.length !== 1 || event?.eventType !== VALIDATION || event.dataVersion !== "1") {
      return reply(400);
    }
    const challenge = z.object({ validationCode: identifier }).safeParse(event.data);
    if (!challenge.success) return reply(400);
    // Deliberately discard validationUrl; never fetch a URL supplied in the request.
    return Response.json({ validationResponse: challenge.data.validationCode });
  }
  const audits: AzureDeliveryAudit[] = [];
  for (const event of parsed.data) {
    if (event.eventType !== DELIVERY || event.dataVersion !== "1.0") return reply(400);
    const data = delivery.safeParse(event.data);
    if (!data.success || !recent(data.data.deliveryAttemptTimeStamp, now)) return reply(400);
    const recipient = data.data.recipient.toLowerCase();
    if (!config.recipients.includes(recipient)) return reply(403);
    audits.push({
      provider: "azure",
      messageId: data.data.messageId,
      eventId: event.id,
      status: statuses[data.data.status],
      recipientHash: createHash("sha256").update(recipient).digest("hex"),
      eventTime: new Date(event.eventTime).toISOString(),
      deliveryAttemptTime: new Date(data.data.deliveryAttemptTimeStamp).toISOString(),
    });
  }
  try {
    await dependencies.store().append(config.teamId, audits);
  } catch (error) {
    // Do not serialize DB errors: a failed bind can contain sensitive parameters.
    return reply(error instanceof AzureEventConflict ? 409 : 503);
  }
  return reply(200);
}
