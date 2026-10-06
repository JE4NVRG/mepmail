import { DescribeActiveReceiptRuleSetCommand } from "@aws-sdk/client-ses";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMailboxReceivingRuleClient,
  type MailboxReceivingRoute,
  mailboxReceivingRuleFacts,
  readMailboxReceivingRules,
} from "../src/mailbox-receiving.js";

const clientState = vi.hoisted(() => ({
  options: [] as Record<string, unknown>[],
  commands: [] as unknown[],
  destroyed: 0,
  reply: {} as unknown,
  error: null as Error | null,
}));

vi.mock("@aws-sdk/client-ses", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-ses")>()),
  SESClient: class {
    constructor(options: Record<string, unknown>) {
      clientState.options.push(options);
    }
    async send(command: unknown) {
      clientState.commands.push(command);
      if (clientState.error) throw clientState.error;
      return clientState.reply;
    }
    destroy() {
      clientState.destroyed += 1;
    }
  },
}));

const DOMAIN = "piloto.example.com";
const TOPIC = "arn:aws:sns:us-east-1:123456789012:mailbox-inbound";
const OTHER_TOPIC = "arn:aws:sns:us-east-1:123456789012:other-inbound";
const LOCATION = { bucket: "mailbox-private", prefix: "receipts/", ownerAccountId: "123456789012" };
const ROUTE: MailboxReceivingRoute = {
  region: "us-east-1",
  topics: [TOPIC],
  locations: [LOCATION],
};

function rule(overrides: Record<string, unknown> = {}) {
  return {
    Name: "exact-recipients",
    Enabled: true,
    TlsPolicy: "Require",
    ScanEnabled: true,
    Recipients: [`person@${DOMAIN}`, `agent@${DOMAIN}`],
    Actions: [
      {
        S3Action: { BucketName: "mailbox-private", ObjectKeyPrefix: "receipts/", TopicArn: TOPIC },
      },
    ],
    ...overrides,
  };
}

function active(...rules: unknown[]) {
  return { Metadata: { Name: "private-inbound" }, Rules: rules };
}

function s3(overrides: Record<string, unknown> = {}) {
  return {
    S3Action: {
      BucketName: "mailbox-private",
      ObjectKeyPrefix: "receipts/",
      TopicArn: TOPIC,
      ...overrides,
    },
  };
}

function expectClosed(output: unknown, domain = DOMAIN, config = ROUTE) {
  const facts = mailboxReceivingRuleFacts(output, domain, config);
  expect(facts.storageReady).toBe(false);
  expect(facts.notificationReady).toBe(false);
  expect(facts.storageRouteMatched).toBe(false);
  expect(facts.notificationRouteMatched).toBe(false);
  expect(facts.resourcePermissionsVerified).toBe(false);
  expect(facts.recipients).toEqual([]);
  return facts;
}

beforeEach(() => {
  clientState.options.length = 0;
  clientState.commands.length = 0;
  clientState.destroyed = 0;
  clientState.reply = {};
  clientState.error = null;
});

describe("read-only active receipt rule client", () => {
  it("uses only DescribeActiveReceiptRuleSet in the selected region", async () => {
    const result = active(rule());
    clientState.reply = result;
    const client = createMailboxReceivingRuleClient({ region: ROUTE.region });
    expect(await readMailboxReceivingRules(client)).toBe(result);
    expect(clientState.commands).toHaveLength(1);
    expect(clientState.destroyed).toBe(1);
    expect(clientState.commands[0]).toBeInstanceOf(DescribeActiveReceiptRuleSetCommand);
    expect((clientState.commands[0] as DescribeActiveReceiptRuleSetCommand).input).toEqual({});
    expect(clientState.options).toEqual([
      {
        region: "us-east-1",
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
      },
    ]);
  });

  it("preserves an AccessDenied read failure without pretending there is a rule", async () => {
    const denied = Object.assign(new Error("read denied"), { name: "AccessDeniedException" });
    clientState.error = denied;
    await expect(
      readMailboxReceivingRules(createMailboxReceivingRuleClient({ region: ROUTE.region })),
    ).rejects.toBe(denied);
    expect(clientState.commands).toHaveLength(1);
    expect(clientState.destroyed).toBe(1);
    expect(clientState.commands[0]).toBeInstanceOf(DescribeActiveReceiptRuleSetCommand);
  });
});

describe("mailboxReceivingRuleFacts", () => {
  it("certifies the single S3 action with its own approved notification, without claiming permissions", () => {
    expect(mailboxReceivingRuleFacts(active(rule()), DOMAIN, ROUTE)).toEqual({
      ruleSetActive: true,
      ruleEnabled: true,
      tlsRequired: true,
      scanEnabled: true,
      storageReady: true,
      notificationReady: true,
      storageRouteMatched: true,
      notificationRouteMatched: true,
      resourcePermissionsVerified: false,
      recipients: [`agent@${DOMAIN}`, `person@${DOMAIN}`],
    });
  });

  it("also accepts the existing ordered S3 plus allowlisted SNS actions", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({
          Actions: [s3(), { SNSAction: { TopicArn: TOPIC, Encoding: "Base64" } }],
        }),
      ),
      DOMAIN,
      ROUTE,
    );
    expect(facts.notificationRouteMatched).toBe(true);
    expect(facts.recipients).toHaveLength(2);
    expect(facts.resourcePermissionsVerified).toBe(false);
  });

  it("normalizes and deduplicates explicit addresses, never synthesizing SES plus aliases", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({ Recipients: [`Person@${DOMAIN.toUpperCase()}`, `person@${DOMAIN}`] }),
        rule({ Recipients: [`person+label@${DOMAIN}`] }),
      ),
      DOMAIN.toUpperCase(),
      ROUTE,
    );
    expect(facts.recipients).toEqual([`person+label@${DOMAIN}`, `person@${DOMAIN}`]);
    expect(facts.recipients).not.toContain(`person+other@${DOMAIN}`);
  });

  it.each([
    ["missing active metadata", { Rules: [rule()] }],
    ["null response", null],
    ["array response", []],
    ["null metadata", { Metadata: null, Rules: [rule()] }],
    ["blank metadata name", { Metadata: { Name: " " }, Rules: [rule()] }],
    ["missing rules", { Metadata: { Name: "active" } }],
    ["null rules", { Metadata: { Name: "active" }, Rules: null }],
    ["null rule", active(null)],
    ["unknown enabled value", active(rule({ Enabled: "true" }))],
    ["null recipient conditions", active(rule({ Recipients: null }))],
    ["malformed recipient", active(rule({ Recipients: [null] }))],
    ["malformed address", active(rule({ Recipients: [`person@@${DOMAIN}`] }))],
    ["whitespace recipient", active(rule({ Recipients: [` person@${DOMAIN}`] }))],
  ])("fails closed for %s", (_name, output) => {
    expectClosed(output);
  });

  it("distinguishes active-but-empty and disabled rules from an active recipient route", () => {
    expect(expectClosed(active()).ruleSetActive).toBe(true);
    const facts = expectClosed(active(rule({ Enabled: false })));
    expect(facts.ruleSetActive).toBe(true);
    expect(facts.ruleEnabled).toBe(false);
  });

  it.each([
    ["no recipients", undefined],
    ["empty conditions", []],
    ["domain condition", [DOMAIN]],
    ["leading-dot parent condition", [".example.com"]],
  ])("refuses broad %s even before an otherwise safe exact rule", (_name, Recipients) => {
    const facts = expectClosed(
      active(rule({ Recipients, Actions: [{ StopAction: { Scope: "RuleSet" } }] }), rule()),
    );
    expect(facts.ruleSetActive).toBe(true);
    expect(facts.ruleEnabled).toBe(true);
  });

  it("a plain parent-domain rule does not apply to its subdomain", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({
          Recipients: ["example.com"],
          Actions: [{ BounceAction: {} }],
        }),
        rule(),
      ),
      DOMAIN,
      ROUTE,
    );
    expect(facts.storageRouteMatched).toBe(true);
  });

  it("a leading-dot condition does not apply to the apex domain", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({
          Recipients: [".example.com"],
          Actions: [{ StopAction: {} }],
        }),
        rule({ Recipients: ["person@example.com"] }),
      ),
      "example.com",
      ROUTE,
    );
    expect(facts.recipients).toEqual(["person@example.com"]);
  });

  it("ignores an unrelated domain rule and an explicitly disabled catch-all", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({ Recipients: ["another.example.com"], Actions: [{ BounceAction: {} }] }),
        rule({ Enabled: false, Recipients: undefined, Actions: [{ StopAction: {} }] }),
        rule(),
      ),
      DOMAIN,
      ROUTE,
    );
    expect(facts.storageRouteMatched).toBe(true);
  });

  it.each(["earlier", "later"])("refuses an %s matching conflicting rule", (position) => {
    const conflicting = rule({ Actions: [s3({ BucketName: "not-allowlisted" })] });
    expectClosed(
      active(...(position === "earlier" ? [conflicting, rule()] : [rule(), conflicting])),
    );
  });

  it.each([
    ["TLS optional", { TlsPolicy: "Optional" }],
    ["scan disabled", { ScanEnabled: false }],
    ["scan truthy instead of boolean", { ScanEnabled: "true" }],
    ["missing actions", { Actions: undefined }],
    ["reversed actions", { Actions: [{ SNSAction: { TopicArn: TOPIC } }, s3()] }],
    [
      "extra stop action",
      { Actions: [s3(), { SNSAction: { TopicArn: TOPIC } }, { StopAction: {} }] },
    ],
    ["mixed first action", { Actions: [{ ...s3(), LambdaAction: {} }] }],
    [
      "mixed second action",
      { Actions: [s3(), { SNSAction: { TopicArn: TOPIC }, BounceAction: {} }] },
    ],
    ["wrong S3 bucket", { Actions: [s3({ BucketName: "unapproved-bucket" })] }],
    ["wrong S3 prefix", { Actions: [s3({ ObjectKeyPrefix: "other/" })] }],
    ["missing S3 prefix", { Actions: [s3({ ObjectKeyPrefix: undefined })] }],
    [
      "SES client-side KMS encryption",
      { Actions: [s3({ KmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test" })] },
    ],
    [
      "missing S3 notification even with SNS action",
      { Actions: [s3({ TopicArn: undefined }), { SNSAction: { TopicArn: TOPIC } }] },
    ],
    ["unapproved S3 notification", { Actions: [s3({ TopicArn: OTHER_TOPIC })] }],
    [
      "unapproved extra SNS notification",
      { Actions: [s3(), { SNSAction: { TopicArn: OTHER_TOPIC } }] },
    ],
    [
      "wrong-region S3 notification",
      { Actions: [s3({ TopicArn: TOPIC.replace("us-east-1", "us-west-2") })] },
    ],
    [
      "wrong-account S3 notification",
      { Actions: [s3({ TopicArn: TOPIC.replace("123456789012", "222222222222") })] },
    ],
    [
      "unknown SNS encoding",
      { Actions: [s3(), { SNSAction: { TopicArn: TOPIC, Encoding: "unknown" } }] },
    ],
    [
      "foreign IAM role",
      { Actions: [s3({ IamRoleArn: "arn:aws:iam::222222222222:role/inbound" })] },
    ],
  ])("refuses %s", (_name, changes) => {
    expect(expectClosed(active(rule(changes))).ruleEnabled).toBe(true);
  });

  it("accepts an account-scoped S3 role without claiming its permissions were checked", () => {
    const facts = mailboxReceivingRuleFacts(
      active(
        rule({
          Actions: [s3({ IamRoleArn: "arn:aws:iam::123456789012:role/mailbox/inbound" })],
        }),
      ),
      DOMAIN,
      ROUTE,
    );
    expect(facts.storageRouteMatched).toBe(true);
    expect(facts.resourcePermissionsVerified).toBe(false);
  });

  it.each([
    ["different selected region", { ...ROUTE, region: "us-west-2" }],
    ["foreign owner", { ...ROUTE, locations: [{ ...LOCATION, ownerAccountId: "222222222222" }] }],
    ["unsafe prefix", { ...ROUTE, locations: [{ ...LOCATION, prefix: "../receipts/" }] }],
    ["empty prefix", { ...ROUTE, locations: [{ ...LOCATION, prefix: "" }] }],
    ["null location", { ...ROUTE, locations: [null] }],
    ["non-topic ARN", { ...ROUTE, topics: ["arn:aws:sqs:us-east-1:123456789012:queue"] }],
    ["wrong AWS partition", { ...ROUTE, topics: [TOPIC.replace("arn:aws:", "arn:aws-cn:")] }],
    ["empty topics", { ...ROUTE, topics: [] }],
  ])("does not certify malformed/current-region-mismatched configuration: %s", (_name, config) => {
    expectClosed(active(rule()), DOMAIN, config as MailboxReceivingRoute);
  });
});
