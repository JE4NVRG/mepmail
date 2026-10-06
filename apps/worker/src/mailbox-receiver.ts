import { createHash } from "node:crypto";
import {
  type Keyring,
  type MailboxTransportMimeAdapter,
  parseMailbox,
  receiveMailboxMime,
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
export function createMailboxReceiver(options: {
  db: Db;
  keys: Keyring;
  mime: MailboxTransportMimeAdapter;
  reader: MailboxObjectReader;
  enabled: boolean;
  topics: readonly string[];
  locations: readonly MailboxPrivateObjectLocation[];
}) {
  const topics = [...options.topics];
  const locations = options.locations.map((location) => ({ ...location }));
  return async (input: TrustedMailboxNotification): Promise<boolean> => {
    if (!isMailboxReceipt(input.event)) return false;
    if (!options.enabled) throw new MailboxProviderEventError("disabled");
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
    await receiveMailboxMime(
      options.db,
      options.keys,
      { sourceId, recipients, raw, assessment },
      options.mime,
    );
    return true;
  };
}
