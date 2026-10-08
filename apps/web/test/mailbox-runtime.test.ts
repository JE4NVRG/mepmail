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
    domainName: "example.invalid",
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
  it("while SES has paused the region, a relay-marked domain sends through the relay, not SES", async () => {
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "smtp-relay:fixture:<id@relay>" });
    const throttle = vi.fn();
    const checkRecipients = vi.fn().mockResolvedValue(true);
    const relayInput = { ...input, cc: ["copy@example.invalid"], bcc: ["hidden@example.invalid"] };
    const result = await createMailboxSesSender(database({ relayEnabledAt: new Date() }), {
      configurationSets,
      exhausted: () => true,
      throttle,
      checkRecipients,
      paused: () => true,
      relay: { name: "fixture", sender: { sendRaw } },
      clientFactory,
    }).send(relayInput);
    expect(result).toEqual({ messageId: "smtp-relay:fixture:<id@relay>" });
    expect(sendRaw).toHaveBeenCalledWith({
      raw: relayInput.raw,
      emailId: input.outboxId,
      to: input.to,
      cc: ["copy@example.invalid"],
      bcc: ["hidden@example.invalid"],
      envelopeFrom: input.from,
    });
    expect(checkRecipients).toHaveBeenCalledWith({
      teamId: input.teamId,
      recipients: [...input.to, "copy@example.invalid", "hidden@example.invalid"],
    });
    expect(throttle).not.toHaveBeenCalled();
    expect(provider.options).toHaveLength(0);
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("keeps SES when the region is not paused or the domain is not marked, and holds still apply", async () => {
    const sendRaw = vi.fn().mockResolvedValue({ messageId: "smtp-relay:fixture:x" });
    const relay = { name: "fixture", sender: { sendRaw } };
    await createMailboxSesSender(database({ relayEnabledAt: new Date() }), {
      configurationSets,
      paused: () => false,
      relay,
      clientFactory,
    }).send(input);
    expect(provider.send).toHaveBeenCalledTimes(1);
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        exhausted: () => true,
        paused: () => true,
        relay,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(
      createMailboxSesSender(database({ relayEnabledAt: new Date(), sendReviewAt: new Date() }), {
        paused: () => true,
        relay,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(
      createMailboxSesSender(database({ relayEnabledAt: new Date() }), {
        paused: () => true,
        relay,
        checkRecipients: async () => false,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(sendRaw).not.toHaveBeenCalled();
  });
  it("a listed domain sends from the failover region while its own is paused, untagged and before the relay", async () => {
    const sendRaw = vi.fn();
    const throttle = vi.fn().mockResolvedValue(undefined);
    const failover = { region: "eu-west-1", domains: new Set(["example.invalid"]) };
    const result = await createMailboxSesSender(database({ relayEnabledAt: new Date() }), {
      configurationSets: { "us-east-1": "private_mail_fixture", "eu-west-1": "private_mail_eu" },
      throttle,
      paused: (region) => region === "us-east-1",
      relay: { name: "fixture", sender: { sendRaw } },
      failover,
      tenants: true,
      clientFactory,
    }).send(input);
    expect(result).toEqual({ messageId: "accepted_fixture" });
    expect(provider.options[0]).toMatchObject({ region: "eu-west-1" });
    expect(provider.inputs[0]).toMatchObject({ ConfigurationSetName: "private_mail_eu" });
    expect(provider.inputs[0]).not.toHaveProperty("TenantName");
    expect(throttle).toHaveBeenCalledWith("eu-west-1", 1);
    expect(sendRaw).not.toHaveBeenCalled();
    // No Mail set in the failover region: deferred, never sent elsewhere.
    await expect(
      createMailboxSesSender(database(), {
        configurationSets,
        paused: (region) => region === "us-east-1",
        failover,
        clientFactory,
      }).send(input),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it("reads the relay's SMTP reply: login or 4xx retries, 5xx refuses, silence stays ambiguous", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = (error: unknown) =>
      createMailboxSesSender(database({ relayEnabledAt: new Date() }), {
        paused: () => true,
        relay: { name: "fixture", sender: { sendRaw: vi.fn().mockRejectedValue(error) } },
        clientFactory,
      }).send(input);
    const smtp = (code: string, responseCode?: number) =>
      Object.assign(new Error("smtp fixture"), { code, responseCode });
    await expect(attempt(smtp("EAUTH", 535))).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(attempt(smtp("EENVELOPE", 451))).rejects.toBeInstanceOf(MailboxSendDeferredError);
    await expect(attempt(smtp("EMESSAGE", 550))).rejects.toBeInstanceOf(MailboxSendRejectedError);
    const timeout = smtp("ETIMEDOUT");
    await expect(attempt(timeout)).rejects.toBe(timeout);
  });
  it("with SES_TENANTS, associates the Mail set with the team tenant once, then tags sends", async () => {
    provider.send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "CreateTenantCommand")
        return { TenantArn: "arn:aws:ses:us-east-1:123456789012:tenant/tenant_fixture/tn-1" };
      if (command.constructor.name === "CreateTenantResourceAssociationCommand") return {};
      return { MessageId: "accepted_fixture" };
    });
    const sender = createMailboxSesSender(database({ tenantConfigSet: "campaign_set" }), {
      configurationSets,
      clientFactory,
      tenants: true,
    });
    await sender.send(input);
    await sender.send(input);
    expect(provider.inputs).toEqual([
      { TenantName: "tenant_fixture" },
      {
        TenantName: "tenant_fixture",
        ResourceArn: "arn:aws:ses:us-east-1:123456789012:identity/example.invalid",
      },
      {
        TenantName: "tenant_fixture",
        ResourceArn: "arn:aws:ses:us-east-1:123456789012:configuration-set/private_mail_fixture",
      },
      expect.objectContaining({
        ConfigurationSetName: "private_mail_fixture",
        TenantName: "tenant_fixture",
      }),
      expect.objectContaining({
        ConfigurationSetName: "private_mail_fixture",
        TenantName: "tenant_fixture",
      }),
    ]);
  });
  it("with SES_TENANTS, a failed association sends untagged and never fails the send", async () => {
    provider.send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "CreateTenantCommand")
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      return { MessageId: "accepted_fixture" };
    });
    expect(
      await createMailboxSesSender(database({ tenantConfigSet: "campaign_set" }), {
        configurationSets,
        clientFactory,
        tenants: true,
      }).send(input),
    ).toEqual({ messageId: "accepted_fixture" });
    expect(provider.inputs.at(-1)).not.toHaveProperty("TenantName");
    // A team whose domain is not in a tenant yet never triggers tenant calls.
    provider.inputs.length = 0;
    await createMailboxSesSender(database({ tenantAssociatedAt: null }), {
      configurationSets,
      clientFactory,
      tenants: true,
    }).send(input);
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]).not.toHaveProperty("TenantName");
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
