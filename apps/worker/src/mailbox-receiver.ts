import { createHash } from "node:crypto";
import {
  type Keyring,
  type MailboxTransportMimeAdapter,
  parseMailbox,
  receiveMailboxMime,
  type TimingWindow,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { assessMailboxReceipt } from "../../../packages/core/src/mailbox-inbound-safety.js";
import type {
  MailboxObjectReader,
  MailboxPrivateObjectLocation,
} from "../../../packages/ses/src/mailbox-storage.js";

/** Internal adapter input, constructed only after authenticated SQS receive and
 * SNS Notification/topic allowlisting, or equivalent verified SNS authentication.
 * This is never a public HTTP request-body contract.
 */
export interface TrustedMailboxNotification {
  topicArn: string;
  snsMessageId: string;
  event: unknown;
  /** SQS SentTimestamp (ms), for timing only. */
  queuedAt?: number | undefined;
  /** SQS ApproximateReceiveCount, for timing only. */
  receiveCount?: number | undefined;
}

export class MailboxProviderEventError extends Error {
  constructor(public readonly code: "disabled" | "topic" | "receipt" | "location" | "evidence") {
    super(`mailbox_provider_${code}`);
  }
}

export function providerRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mailboxProviderAddress(value: unknown): string {
  const parsed = typeof value === "string" ? parseMailbox(value) : null;
  if (!parsed || parsed.name || !/^[\x21-\x7e]+$/.test(parsed.address))
    throw new MailboxProviderEventError("evidence");
  return parsed.address.toLowerCase();
}

export function assertMailboxNotificationTopic(
  input: TrustedMailboxNotification,
  topics: readonly string[],
): { region: string; accountId: string } {
  const topic = /^arn:aws(?:-us-gov|-cn)?:sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_-]+$/.exec(
    input.topicArn,
  );
  if (
    !topic ||
    !topics.includes(input.topicArn) ||
    typeof input.snsMessageId !== "string" ||
    !/^[\x21-\x7e]{1,128}$/.test(input.snsMessageId)
  )
    throw new MailboxProviderEventError("topic");
  return { region: topic[1]!, accountId: topic[2]! };
}

export function isMailboxReceipt(event: unknown): boolean {
  return providerRecord(event)?.notificationType === "Received";
}

/** true means durable core persistence completed and the SQS message can be
 * acknowledged. Every recognized but unsafe/unavailable receipt throws, retaining
 * its source for redelivery/DLQ; false is reserved for unrelated SES events.
 */
/** SES receipt -> stored, SQS wait before this attempt, and this attempt's own time. */
export function recordReceiptTimings(
  timings: TimingWindow | undefined,
  input: TrustedMailboxNotification,
  sesTimestamp: unknown,
  started: number,
) {
  if (!timings) return;
  const now = Date.now();
  const receivedAt = typeof sesTimestamp === "string" ? Date.parse(sesTimestamp) : Number.NaN;
  if (Number.isFinite(receivedAt)) timings.record("receipt.ses_to_stored", now - receivedAt);
  if (input.queuedAt !== undefined) timings.record("receipt.queue_wait", started - input.queuedAt);
  timings.record("receipt.processing", now - started);
  // A stored redelivery: an earlier attempt failed and waited out the visibility timeout.
  if ((input.receiveCount ?? 1) > 1) timings.record("receipt.redelivered", now - receivedAt);
}

export function createMailboxReceiver(options: {
  db: Db;
  keys: Keyring;
  mime: MailboxTransportMimeAdapter;
  reader: MailboxObjectReader;
  enabled: boolean;
  topics: readonly string[];
  locations: readonly MailboxPrivateObjectLocation[];
  /** Sender-decision key (deriveMailboxSenderKey): blocked senders are filed in Spam. */
  senderKey?: Buffer | undefined;
  /** Arms the drains for the mailbox.received rows the receive committed. */
  enqueueWebhook?: WebhookEnqueue | undefined;
  /** Receipt stages in aggregate (SES->stored, queue wait, processing); no ids. */
  timings?: TimingWindow | undefined;
}) {
  const topics = [...options.topics];
  const locations = options.locations.map((location) => ({ ...location }));
  return async (input: TrustedMailboxNotification): Promise<boolean> => {
    if (!isMailboxReceipt(input.event)) return false;
    if (!options.enabled) throw new MailboxProviderEventError("disabled");
    const started = Date.now();
    const topic = assertMailboxNotificationTopic(input, topics);
    const event = providerRecord(input.event)!;
    const mail = providerRecord(event.mail);
    const receipt = providerRecord(event.receipt);
    const action = providerRecord(receipt?.action);
    const messageId = mail?.messageId;
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(messageId) ||
      !receipt ||
      action?.type !== "S3" ||
      typeof action.bucketName !== "string" ||
      typeof action.objectKey !== "string" ||
      (action.topicArn !== undefined && action.topicArn !== input.topicArn) ||
      !Array.isArray(receipt.recipients) ||
      !receipt.recipients.length ||
      receipt.recipients.length > 20
    )
      throw new MailboxProviderEventError("receipt");
    const objectKey = action.objectKey;
    const location = locations.find(
      (entry) =>
        entry.bucket === action.bucketName &&
        entry.ownerAccountId === topic.accountId &&
        objectKey === `${entry.prefix}${messageId}`,
    );
    if (!location) throw new MailboxProviderEventError("location");
    // Only trusted SMTP RCPT TO recipients from the SES receipt determine fanout.
    const recipients = [...new Set(receipt.recipients.map(mailboxProviderAddress))];
    const assessment = assessMailboxReceipt(receipt);
    const raw = await options.reader.read({ bucket: location.bucket, key: objectKey });
    const sourceId = `ses-s3:${createHash("sha256")
      .update(
        JSON.stringify([topic.region, topic.accountId, location.bucket, objectKey, messageId]),
      )
      .digest("hex")}`;
    const { webhooks } = await receiveMailboxMime(
      options.db,
      options.keys,
      {
        sourceId,
        recipients,
        raw,
        assessment,
        ...(options.senderKey ? { senderKey: options.senderKey } : {}),
      },
      options.mime,
    );
    recordReceiptTimings(options.timings, input, mail?.timestamp, started);
    // The message is stored: a failed arm only delays the webhook until the reconcile
    // sweep, so it never fails the receipt (a redelivery would write no new rows).
    if (webhooks.length && options.enqueueWebhook)
      await options.enqueueWebhook(webhooks).catch((error: unknown) => {
        console.warn(
          `mailbox.received: drain not armed, reconcile picks it up (${error instanceof Error ? error.name : "error"})`,
        );
      });
    return true;
  };
}
