import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { describe, it, expect } from "vitest";
import { pollSqsOnce } from "../src/sqs-poller.js";

const TOPIC = "arn:aws:sns:us-east-1:123456789012:mepmail-events";
const PRIVATE = "private-offline-fixture@example.com";
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    Type: "Notification",
    MessageId: "sns-valid",
    TopicArn: TOPIC,
    Message: JSON.stringify({
      eventType: "Delivery",
      mail: { messageId: "ses-valid", timestamp: "2026-09-28T12:00:00.000Z" },
      delivery: { timestamp: "2026-09-28T12:00:00.000Z", recipients: [PRIVATE] },
    }),
    Timestamp: "2026-09-28T12:00:00.000Z",
    SignatureVersion: "1",
    Signature: "offline",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/offline.pem",
    ...overrides,
  };
}
const invalidCases: [string, string][] = [
  ["outer JSON", PRIVATE],
  ["SNS schema", JSON.stringify(envelope({ Signature: "" }))],
  ["SNS Type", JSON.stringify(envelope({ Type: "SubscriptionConfirmation" }))],
  [
    "foreign topic",
    JSON.stringify(envelope({ TopicArn: "arn:aws:sns:us-east-1:999999999999:foreign" })),
  ],
  ["inner JSON", JSON.stringify(envelope({ Message: PRIVATE }))],
  [
    "unsupported SES event",
    JSON.stringify(
      envelope({
        Message: JSON.stringify({ eventType: "Unsupported", mail: { messageId: "ses-x" } }),
      }),
    ),
  ],
  [
    "missing SES MessageId",
    JSON.stringify(
      envelope({
        Message: JSON.stringify({
          eventType: "Delivery",
          mail: { timestamp: "2026-09-28T12:00:00.000Z" },
        }),
      }),
    ),
  ],
  [
    "invalid bounce parser",
    JSON.stringify(
      envelope({
        Message: JSON.stringify({
          eventType: "Bounce",
          mail: { messageId: "ses-x" },
          bounce: { bounceType: "Unsupported", bouncedRecipients: [{ emailAddress: PRIVATE }] },
        }),
      }),
    ),
  ],
];
function depsFor(messages: Message[], failedId?: string) {
  const deleted: string[] = [],
    enqueued: string[] = [],
    logs: string[] = [];
  const deps = {
    allowedTopicArns: [TOPIC],
    queueUrl: "offline",
    log: (line: string) => logs.push(line),
    sqs: {
      send: async (command: ReceiveMessageCommand | DeleteMessageBatchCommand) => {
        if (command instanceof ReceiveMessageCommand) return { Messages: messages };
        for (const entry of command.input.Entries ?? []) deleted.push(entry.Id!);
        return {};
      },
    },
    enqueueSesEvent: async (_event: unknown, id: string) => {
      if (id === failedId) throw Error(PRIVATE);
      enqueued.push(id);
    },
  };
  return { deps, deleted, enqueued, logs };
}
describe("invalid SQS messages remain for configured redrive", () => {
  it.each(invalidCases)("retains %s without ACK or sensitive log", async (_name, body) => {
    const { deps, deleted, enqueued, logs } = depsFor([
      { MessageId: "sqs-invalid", ReceiptHandle: "rh-invalid", Body: body },
    ]);
    expect(await pollSqsOnce(deps, 0)).toBe(1);
    expect(deleted).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("retained");
    expect(logs.join(" ")).not.toContain(PRIVATE);
    expect(logs.join(" ")).not.toContain("999999999999");
  });
  it("mixed receive ACKs only valid committed enqueue; invalid and enqueue failure remain", async () => {
    const messages = [
      { MessageId: "sqs-valid", ReceiptHandle: "rh-valid", Body: JSON.stringify(envelope()) },
      { MessageId: "sqs-invalid", ReceiptHandle: "rh-invalid", Body: PRIVATE },
      {
        MessageId: "sqs-failed",
        ReceiptHandle: "rh-failed",
        Body: JSON.stringify(envelope({ MessageId: "sns-failed" })),
      },
    ];
    const { deps, deleted, enqueued, logs } = depsFor(messages, "sns-failed");
    expect(await pollSqsOnce(deps, 0)).toBe(3);
    expect(deleted).toEqual(["sqs-valid"]);
    expect(enqueued).toEqual(["sns-valid"]);
    expect(logs).toHaveLength(2);
    expect(logs.join(" ")).not.toContain(PRIVATE);
  });
});
