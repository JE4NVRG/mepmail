import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import type { SerializedSesEvent } from "@millionsend/queue";
import { parseSesEvent, snsMessageSchema } from "@millionsend/ses";

/**
 * SES event ingestion for deployments SNS cannot push to: SES → SNS topic →
 * SQS queue → this long-poll loop → the same "ses.event" job the https
 * endpoint enqueues. No SNS signature verification here — ReceiveMessage is
 * IAM-authenticated and the queue policy only lets the events topic write —
 * but the topic allowlist still applies, so a queue hand-pointed at foreign
 * topics stays rejected (mirrors the https endpoint's rule).
 */

export interface SqsPollerDeps {
  sqs: {
    send(command: ReceiveMessageCommand | DeleteMessageBatchCommand): Promise<unknown>;
  };
  queueUrl: string;
  allowedTopicArns: string[];
  enqueueSesEvent(event: SerializedSesEvent, snsMessageId: string): Promise<void>;
  /** Trusted private-mail dispatcher. true means persistence is complete; a
   * throw retains the receipt for retry/DLQ. It runs before outbound parsing.
   */
  dispatchPrivateMail?:
    | ((input: { topicArn: string; snsMessageId: string; event: unknown }) => Promise<boolean>)
    | undefined;
  log?: ((line: string) => void) | undefined;
  /**
   * Parallel long-poll loops. One loop is bounded by the round trip to the
   * queue's region (two per ten messages); each loop owns the receipt handles
   * it fetched, and the SNS message id dedupes the rare duplicate delivery.
   */
  concurrency?: number | undefined;
}

/**
 * One receive/process/delete round; returns how many messages arrived.
 * Unusable messages (non-JSON, foreign topic, unparseable event) are deleted —
 * redelivery can never fix them. Private mail is acknowledged only after its
 * dispatcher succeeds; disabled transport or persistence failure retains it.
 */
export async function pollSqsOnce(deps: SqsPollerDeps, waitSeconds = 20): Promise<number> {
  const log = deps.log ?? (() => {});
  const received = (await deps.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: deps.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
    }),
  )) as ReceiveMessageCommandOutput;
  const messages: Message[] = received.Messages ?? [];
  if (messages.length === 0) return 0;

  const done: Message[] = [];
  for (const message of messages) {
    try {
      await processMessage(message, deps);
      done.push(message);
    } catch {
      // Private MIME, object keys and provider request details stay out of logs.
      log("sqs poller: processing failed, leaving message for redelivery");
    }
  }
  if (done.length > 0) {
    await deps.sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: deps.queueUrl,
        Entries: done.map((message, index) => ({
          Id: message.MessageId ?? String(index),
          ReceiptHandle: message.ReceiptHandle as string,
        })),
      }),
    );
  }
  return messages.length;
}

async function processMessage(message: Message, deps: SqsPollerDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  let raw: unknown;
  try {
    raw = JSON.parse(message.Body ?? "");
  } catch {
    log("sqs poller: dropped non-JSON message");
    return;
  }
  const parsed = snsMessageSchema.safeParse(raw);
  if (!parsed.success || parsed.data.Type !== "Notification") return;
  if (!deps.allowedTopicArns.includes(parsed.data.TopicArn)) {
    log(`sqs poller: dropped message from unallowed topic ${parsed.data.TopicArn}`);
    return;
  }
  let inner: unknown;
  try {
    inner = JSON.parse(parsed.data.Message);
  } catch {
    return;
  }
  if (
    deps.dispatchPrivateMail &&
    (await deps.dispatchPrivateMail({
      topicArn: parsed.data.TopicArn,
      snsMessageId: parsed.data.MessageId,
      event: inner,
    }))
  )
    return;
  const candidate = inner as {
    notificationType?: unknown;
    mail?: { tags?: Record<string, unknown> };
  } | null;
  if (
    candidate?.notificationType === "Received" ||
    candidate?.mail?.tags?.mepmail_outbox_id !== undefined ||
    candidate?.mail?.tags?.mepmail_attempt_id !== undefined
  )
    throw new Error("Private mail requires an enabled trusted dispatcher");
  const event = parseSesEvent(inner);
  if (!event) return;
  // The SNS MessageId dedupes with the https path: same key, same singleton
  // queue job, same durable email_events.sns_message_id uniqueness.
  await deps.enqueueSesEvent(
    { ...event, occurredAt: event.occurredAt.toISOString() },
    parsed.data.MessageId,
  );
}

/** Endless long-poll loop; receive errors back off instead of crashing the worker. */
export function startSqsPoller(deps: SqsPollerDeps): { stop(): void } {
  let running = true;
  const log = deps.log ?? (() => {});
  const loop = async () => {
    while (running) {
      try {
        await pollSqsOnce(deps);
      } catch (error) {
        log(`sqs poller: receive failed, retrying in 10s: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  };
  for (let i = 0; i < Math.max(1, deps.concurrency ?? 1); i++) void loop();
  return {
    stop() {
      running = false;
    },
  };
}
