import { MailboxSendDeferredError, MailboxSendRejectedError } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxTransportMime } from "@/server/mailbox-transport";
import {
  createMailboxSesSender,
  mailboxWorkerMime,
  parseMailboxSesConfigurationSets,
} from "../../worker/src/mailbox-sender.js";

const provider = vi.hoisted(() => ({
  options: [] as unknown[],
  inputs: [] as unknown[],
  send: vi.fn(),
}));
const clientFactory = (options: unknown) => {
  provider.options.push(options);
  return {
    send(command: { input: unknown }) {
      provider.inputs.push(command.input);
      return provider.send(command);
    },
  };
};
function database(extra = {}) {
  const row = {
    region: "us-east-1",
    status: "verified",
    address: "person@example.invalid",
    suspendedAt: null,
    configurationSet: "campaign_fixture",
    tenantName: "tenant_fixture",
    tenantAssociatedAt: new Date(),
    tenantConfigSet: "private_mail_fixture",
    ...extra,
  };
  const query = { from: () => query, innerJoin: () => query, where: async () => [row] };
  return { select: () => query } as unknown as Db;
}
const input = {
  idempotencyKey: "outbox_fixture",
  outboxId: "outbox_fixture",
  attemptId: "attempt_fixture",
  teamId: "team_fixture",
  mailboxId: "box_fixture",
  from: "person@example.invalid",
  to: ["recipient@example.invalid"],
  cc: [],
  bcc: [],
  raw: Buffer.from(
    "From: person@example.invalid\r\nTo: recipient@example.invalid\r\n\r\nPrivate body",
  ),
};
const configurationSets = { "us-east-1": "private_mail_fixture" };
beforeEach(() => {
  provider.options.length = 0;
  provider.inputs.length = 0;
  provider.send.mockReset().mockResolvedValue({ MessageId: "accepted_fixture" });
});
describe("private Mail runtime adapters", () => {
  it("rejects duplicated From headers even when the parser collapses them to one", async () => {
    const bad = Buffer.from("From: evil@example.invalid\r\n" + input.raw.toString());
    await expect(mailboxTransportMime.parse(bad)).rejects.toMatchObject({ code: "invalid" });
    await expect(mailboxWorkerMime.parse(bad)).rejects.toMatchObject({ code: "invalid" });
    expect((await mailboxWorkerMime.parse(input.raw)).from).toBe(input.from);
  });
  it("uses one SDK attempt, immutable raw, exact envelope, evidence tags and associated tenant", async () => {
    const throttle = vi.fn().mockResolvedValue(undefined);
    const result = await createMailboxSesSender(database(), {
      configurationSets,
      throttle,
      clientFactory,
    }).send(input);
    expect(result).toEqual({ messageId: "accepted_fixture" });
    expect(throttle).toHaveBeenCalledWith("us-east-1", 1);
    expect(provider.options).toEqual([
      {
        region: "us-east-1",
        maxAttempts: 1,
        ignoreConfiguredEndpointUrls: true,
        requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
      },
    ]);
    expect(provider.inputs[0]).toMatchObject({
      FromEmailAddress: input.from,
      Content: { Raw: { Data: input.raw } },
      Destination: { ToAddresses: input.to },
      ConfigurationSetName: "private_mail_fixture",
      TenantName: "tenant_fixture",
      EmailTags: [
        { Name: "mepmail_outbox_id", Value: input.outboxId },
        { Name: "mepmail_attempt_id", Value: input.attemptId },
      ],
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it("reserves distinct To/Cc/Bcc recipients before one immutable provider request", async () => {
    const original = Buffer.from(input.raw);
    const mutable = {
      ...input,
      raw: Buffer.from(original),
      to: ["recipient@example.invalid", "second@example.invalid"],
      cc: ["recipient@example.invalid", "third@example.invalid"],
      bcc: ["third@example.invalid"],
    };
    let release = () => {};
    let entered = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const throttle = vi.fn(async () => {
      entered();
      await blocked;
    });
    const checkRecipients = vi.fn().mockResolvedValue(true);
    const pending = createMailboxSesSender(database(), {
      configurationSets,
      throttle,
      checkRecipients,
      clientFactory,
    }).send(mutable);
    await started;
    expect(throttle).toHaveBeenCalledWith("us-east-1", 3);
    expect(provider.send).not.toHaveBeenCalled();
    mutable.raw.fill(0);
    mutable.to.push("late@example.invalid");
    mutable.cc.length = 0;
    mutable.bcc.length = 0;
    mutable.from = "changed@example.invalid";
    release();
    await expect(pending).resolves.toEqual({ messageId: "accepted_fixture" });
    expect(checkRecipients).toHaveBeenCalledWith({
      teamId: input.teamId,
      recipients: ["recipient@example.invalid", "second@example.invalid", "third@example.invalid"],
    });
    expect(provider.inputs[0]).toMatchObject({
      FromEmailAddress: input.from,
      Content: { Raw: { Data: original } },
      Destination: {
        ToAddresses: ["recipient@example.invalid", "second@example.invalid"],
        CcAddresses: ["recipient@example.invalid", "third@example.invalid"],
        BccAddresses: ["third@example.invalid"],
      },
      EmailTags: [
        { Name: "mepmail_outbox_id", Value: input.outboxId },
        { Name: "mepmail_attempt_id", Value: input.attemptId },
      ],
    });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it("defers an aborted permit or quota exhaustion during the wait without calling the provider", async () => {
    const aborted = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        throttle: aborted,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    let exhausted = false;
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        exhausted: () => exhausted,
        throttle: async () => {
          exhausted = true;
        },
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(provider.options).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("rejects an empty or oversized recipient cost before throttle and provider", async () => {
    const throttle = vi.fn();
    for (const to of [[], Array.from({ length: 21 }, (_, i) => `recipient${i}@example.invalid`)])
      await expect(
        createMailboxSesSender(database(), { configurationSets, throttle, clientFactory }).send({
          ...input,
          to,
        }),
      ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(throttle).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("checks recipient blocks after the permit and never invokes SES after a block or lookup failure", async () => {
    const order: string[] = [];
    const checkRecipients = vi.fn(async () => {
      order.push("check");
      return false;
    });
    const throttle = vi.fn(async () => {
      order.push("permit");
    });
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        throttle,
        checkRecipients,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(order).toEqual(["permit", "check"]);
    expect(checkRecipients).toHaveBeenCalledWith({
      teamId: input.teamId,
      recipients: input.to,
    });
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        throttle,
        checkRecipients: async () => {
          throw new Error("fixture lookup unavailable");
        },
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(provider.options).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("defers regional quota before provider invocation and refuses globally suspended teams", async () => {
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        exhausted: () => true,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(
      createMailboxSesSender(database({ suspendedAt: new Date() }), {
        configurationSets,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("does not attach an unassociated tenant and distinguishes definitive refusal from ambiguity", async () => {
    await createMailboxSesSender(database({ tenantConfigSet: "different" }), {
      configurationSets,
      clientFactory,
    }).send(input);
    expect(provider.inputs[0]).not.toHaveProperty("TenantName");
    provider.send.mockRejectedValueOnce(
      Object.assign(new Error("refused"), { name: "MessageRejected" }),
    );
    await expect(
      createMailboxSesSender(database(), { configurationSets, clientFactory }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    const timeout = Object.assign(new Error("unknown"), { name: "TimeoutError" });
    provider.send.mockRejectedValueOnce(timeout);
    await expect(
      createMailboxSesSender(database(), { configurationSets, clientFactory }).send(input),
    ).rejects.toBe(timeout);
  });

  it("defers missing private regional mappings and rejects the domain campaign set before throttle or SDK", async () => {
    const throttle = vi.fn().mockResolvedValue(undefined);
    const missingMappings: Array<Record<string, string> | null | undefined> = [
      undefined,
      null,
      {},
      { "us-west-2": "private_other_region" },
    ];
    for (const mapping of missingMappings)
      await expect(
        createMailboxSesSender(database(), {
          configurationSets: mapping,
          throttle,
          clientFactory,
        }).send(input),
      ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(
      createMailboxSesSender(database(), {
        configurationSets: { "us-east-1": "campaign_fixture" },
        throttle,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(throttle).not.toHaveBeenCalled();
    expect(provider.options).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("rejects raw SES overrides and evidence tags before provider invocation, leaving inbound MIME parsing available", async () => {
    const throttle = vi.fn().mockResolvedValue(undefined);
    for (const header of [
      "X-SES-CONFIGURATION-SET: campaign_fixture",
      "X-SES-SOURCE-ARN: arn:aws:ses:us-east-1:123456789012:identity/other.invalid",
      "X-SES-FROM-ARN: arn:aws:ses:us-east-1:123456789012:identity/other.invalid",
      "X-SES-RETURN-PATH-ARN: arn:aws:ses:us-east-1:123456789012:identity/other.invalid",
      "X-SES-MESSAGE-TAGS: mepmail_outbox_id=spoof,mepmail_attempt_id=spoof",
      "x-SeS-unknown-future-control: value",
    ]) {
      const raw = Buffer.from(`${header}\r\n${input.raw.toString()}`);
      expect((await mailboxWorkerMime.parse(raw)).from).toBe(input.from);
      await expect(
        createMailboxSesSender(database(), { configurationSets, throttle, clientFactory }).send({
          ...input,
          raw,
        }),
      ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    }
    expect(throttle).not.toHaveBeenCalled();
    expect(provider.options).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("strictly parses operator region/name JSON and freezes an independent mapping", async () => {
    expect(parseMailboxSesConfigurationSets()).toBeNull();
    expect(parseMailboxSesConfigurationSets("  ")).toBeNull();
    const parsed = parseMailboxSesConfigurationSets(
      '{"us-east-1":"private_mail_fixture","eu-west-1":"Private-Mail_1"}',
    );
    expect(parsed).toEqual({ "us-east-1": "private_mail_fixture", "eu-west-1": "Private-Mail_1" });
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const value of [
      "not-json",
      "null",
      "[]",
      '"string"',
      '{"not-a-region":"private"}',
      '{"us-east-1":null}',
      '{"us-east-1":1}',
      '{"us-east-1":""}',
      '{"us-east-1":"with spaces"}',
      '{"us-east-1":"tracking/set"}',
      JSON.stringify({ "us-east-1": "a".repeat(65) }),
      JSON.stringify({ "us-east-1": "p".repeat(17 * 1024) }),
      '{"__proto__":"private"}',
    ])
      expect(() => parseMailboxSesConfigurationSets(value)).toThrow(
        "mailbox_ses_configuration_sets_invalid",
      );
    expect(() =>
      createMailboxSesSender(database(), {
        configurationSets: { "us-east-1": "invalid name" },
        clientFactory,
      }),
    ).toThrow("mailbox_ses_configuration_sets_invalid");
    const mutable = { ...configurationSets };
    const sender = createMailboxSesSender(database(), {
      configurationSets: mutable,
      clientFactory,
    });
    mutable["us-east-1"] = "campaign_fixture";
    await sender.send(input);
    expect(provider.inputs[0]).toMatchObject({ ConfigurationSetName: "private_mail_fixture" });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});
