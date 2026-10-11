import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import type { SerializedSesEvent } from "@millionsend/queue";
import { describe, expect, it } from "vitest";
import { pollSqsOnce, type SqsPollerDeps } from "../src/sqs-poller.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:mepmail-events";

function envelope(overrides: Partial<Record<string, string>> = {}): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: "sns-msg-1",
    TopicArn: TOPIC,
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: {
        messageId: "ses-1",
        timestamp: "2026-08-16T12:00:00.000Z",
        tags: { mepmail_email_id: ["00000000-0000-4000-8000-000000000001"] },
      },
      delivery: { timestamp: "2026-08-16T12:00:01.000Z", smtpResponse: "250 ok" },
    }),
    Timestamp: "2026-08-16T12:00:01.100Z",
    SignatureVersion: "1",
    Signature: "sig",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    ...overrides,
  });
}

function fakeDeps(messages: Message[], options: { enqueueError?: Error } = {}) {
  const enqueued: Array<{ event: SerializedSesEvent; snsMessageId: string }> = [];
  const deleted: string[] = [];
  const deps: SqsPollerDeps = {
    sqs: {
      send: async (command) => {
        if (command instanceof ReceiveMessageCommand) return { Messages: messages };
        if (command instanceof DeleteMessageBatchCommand) {
          for (const entry of command.input.Entries ?? []) deleted.push(entry.Id as string);
        }
        return {};
      },
    },
    queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/mepmail-events",
    allowedTopicArns: [TOPIC],
    enqueueSesEvent: async (event, snsMessageId) => {
      if (options.enqueueError) throw options.enqueueError;
      enqueued.push({ event, snsMessageId });
    },
    log: () => {},
  };
  return { deps, enqueued, deleted };
}

describe("pollSqsOnce", () => {
  it("enqueues a valid SES event under its SNS MessageId and deletes the message", async () => {
    const { deps, enqueued, deleted } = fakeDeps([
      { MessageId: "sqs-1", ReceiptHandle: "rh-1", Body: envelope() },
    ]);
    expect(await pollSqsOnce(deps, 0)).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.snsMessageId).toBe("sns-msg-1");
    expect(enqueued[0]?.event.eventType).toBe("Delivery");
    expect(enqueued[0]?.event.occurredAt).toBe("2026-08-16T12:00:01.000Z");
    expect(enqueued[0]?.event.emailId).toBe("00000000-0000-4000-8000-000000000001");
    expect(deleted).toEqual(["sqs-1"]);
  });

  it("retains foreign-topic and malformed messages for the DLQ redrive without enqueueing", async () => {
    const { deps, enqueued, deleted } = fakeDeps([
      {
        MessageId: "sqs-foreign",
        ReceiptHandle: "rh-1",
        Body: envelope({ TopicArn: "arn:aws:sns:us-east-1:999999999999:evil" }),
      },
      { MessageId: "sqs-garbage", ReceiptHandle: "rh-2", Body: "not json" },
      { MessageId: "sqs-inner", ReceiptHandle: "rh-3", Body: envelope({ Message: "not json" }) },
    ]);
    expect(await pollSqsOnce(deps, 0)).toBe(3);
    expect(enqueued).toHaveLength(0);
    // Not ACKed: SQS moves them to mepmail-events-dlq after maxReceiveCount
    // (see sqs-invalid-offline.test.ts).
    expect(deleted).toEqual([]);
  });

  it("keeps the message on the queue when enqueueing fails", async () => {
    const { deps, enqueued, deleted } = fakeDeps(
      [{ MessageId: "sqs-1", ReceiptHandle: "rh-1", Body: envelope() }],
      { enqueueError: new Error("db down") },
    );
    expect(await pollSqsOnce(deps, 0)).toBe(1);
    expect(enqueued).toHaveLength(0);
    expect(deleted).toEqual([]);
  });

  it("returns 0 and deletes nothing on an empty receive", async () => {
    const { deps, deleted } = fakeDeps([]);
    expect(await pollSqsOnce(deps, 0)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("dispatches trusted private mail before outbound parsing and acknowledges persistence", async () => {
    const receipt = {
      notificationType: "Received",
      receipt: { recipients: ["box@example.invalid"] },
    };
    const { deps, enqueued, deleted } = fakeDeps([
      {
        MessageId: "private-1",
        ReceiptHandle: "private-rh",
        Body: envelope({ Message: JSON.stringify(receipt) }),
      },
    ]);
    const seen: unknown[] = [];
    deps.dispatchPrivateMail = async (input) => {
      seen.push(input);
      return true;
    };
    await pollSqsOnce(deps, 0);
    expect(seen).toEqual([{ topicArn: TOPIC, snsMessageId: "sns-msg-1", event: receipt }]);
    expect(enqueued).toHaveLength(0);
    expect(deleted).toEqual(["private-1"]);
  });

  it("asks SQS when each event was queued and passes it, with the delivery count, to private mail", async () => {
    const requested: unknown[] = [];
    const seen: unknown[] = [];
    const deps: SqsPollerDeps = {
      sqs: {
        send: async (command) => {
          if (command instanceof ReceiveMessageCommand) {
            requested.push(command.input.MessageSystemAttributeNames);
            return {
              Messages: [
                {
                  MessageId: "private-2",
                  ReceiptHandle: "private-rh-2",
                  Body: envelope({ Message: JSON.stringify({ notificationType: "Received" }) }),
                  Attributes: { SentTimestamp: "1760140800000", ApproximateReceiveCount: "2" },
                },
              ],
            };
          }
          return {};
        },
      },
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/mepmail-events",
      allowedTopicArns: [TOPIC],
      enqueueSesEvent: async () => {},
      dispatchPrivateMail: async (input) => {
        seen.push(input);
        return true;
      },
      log: () => {},
    };
    await pollSqsOnce(deps, 0);
    expect(requested).toEqual([["SentTimestamp", "ApproximateReceiveCount"]]);
    expect(seen).toEqual([expect.objectContaining({ queuedAt: 1760140800000, receiveCount: 2 })]);
  });

  it("retains private receipts/evidence while the handler is unavailable or fails", async () => {
    for (const privateEvent of [
      { notificationType: "Received", receipt: { recipients: [] } },
      { eventType: "Send", mail: { tags: { mepmail_outbox_id: ["pending"] } } },
    ]) {
      const { deps, enqueued, deleted } = fakeDeps([
        {
          MessageId: "private-1",
          ReceiptHandle: "private-rh",
          Body: envelope({ Message: JSON.stringify(privateEvent) }),
        },
      ]);
      await pollSqsOnce(deps, 0);
      expect(deleted).toEqual([]);
      deps.dispatchPrivateMail = async () => {
        throw new Error("private persistence unavailable");
      };
      await pollSqsOnce(deps, 0);
      expect(deleted).toEqual([]);
      expect(enqueued).toHaveLength(0);
    }
  });

  it("never passes a foreign topic to the private dispatcher", async () => {
    const { deps, deleted } = fakeDeps([
      {
        MessageId: "foreign",
        ReceiptHandle: "rh",
        Body: envelope({ TopicArn: "arn:aws:sns:us-east-1:999999999999:foreign" }),
      },
    ]);
    let calls = 0;
    deps.dispatchPrivateMail = async () => {
      calls++;
      return true;
    };
    await pollSqsOnce(deps, 0);
    expect(calls).toBe(0);
    expect(deleted).toEqual([]);
  });
});
