import {
  DescribeActiveReceiptRuleSetCommand,
  type ReceiptRule,
  UpdateReceiptRuleCommand,
} from "@aws-sdk/client-ses";
import { describe, expect, it } from "vitest";
import {
  appendMailboxReceivingRecipients,
  type MailboxProvisioningConfiguration,
  mailboxProtectedRuleSha256,
  parseMailboxProvisioningConfiguration,
} from "../src/mailbox-provisioning.js";

const seed: ReceiptRule & { Name: string } = {
  Name: "existing-rule",
  Enabled: true,
  TlsPolicy: "Require",
  ScanEnabled: true,
  Recipients: ["support@example.com"],
  Actions: [
    {
      S3Action: {
        BucketName: "private-existing",
        ObjectKeyPrefix: "mail/",
        TopicArn: "arn:aws:sns:us-east-1:123456789012:existing",
      },
    },
  ],
};
const config: MailboxProvisioningConfiguration = {
  version: 1,
  region: "us-east-1",
  ruleSetName: "existing-set",
  ruleName: seed.Name,
  protectedRuleSha256: mailboxProtectedRuleSha256(seed),
};
function client(rule: ReceiptRule = structuredClone(seed), uncertain = false, apply = true) {
  const commands: unknown[] = [];
  let destroyed = false;
  return {
    commands,
    get destroyed() {
      return destroyed;
    },
    async send(command: DescribeActiveReceiptRuleSetCommand | UpdateReceiptRuleCommand) {
      commands.push(command);
      if (command instanceof DescribeActiveReceiptRuleSetCommand)
        return { Metadata: { Name: config.ruleSetName }, Rules: [structuredClone(rule)] };
      if (!command.input.Rule) throw new Error("missing rule");
      if (apply) rule = structuredClone(command.input.Rule);
      if (uncertain) throw new Error("network");
      return {};
    },
    destroy() {
      destroyed = true;
    },
  };
}
describe("recipient activation on the explicitly pinned existing rule", () => {
  it("keeps absence closed and rejects malformed config", () => {
    expect(parseMailboxProvisioningConfiguration(undefined)).toBeNull();
    expect(parseMailboxProvisioningConfiguration(JSON.stringify(config))).toEqual(config);
    expect(() => parseMailboxProvisioningConfiguration('{"version":1}')).toThrow("configuration");
  });
  it("adds an exact address and preserves actions, TLS, scan and existing recipients", async () => {
    const c = client();
    expect(await appendMailboxReceivingRecipients(c, config, ["luna@example.com"])).toEqual({
      confirmed: true,
      added: 1,
    });
    const update = c.commands[1] as UpdateReceiptRuleCommand;
    expect(update.input).toEqual({
      RuleSetName: config.ruleSetName,
      Rule: { ...seed, Recipients: ["luna@example.com", "support@example.com"] },
    });
    expect(c.destroyed).toBe(true);
  });
  it("replays with reads only", async () => {
    const c = client();
    await appendMailboxReceivingRecipients(c, config, ["luna@example.com"]);
    expect(await appendMailboxReceivingRecipients(c, config, ["luna@example.com"])).toEqual({
      confirmed: true,
      added: 0,
    });
    expect(c.commands.filter((x) => x instanceof UpdateReceiptRuleCommand)).toHaveLength(1);
  });
  it.each(["TlsPolicy", "ScanEnabled", "Actions"])(
    "rejects drift in %s before any mutation",
    async (field) => {
      const changed = {
        ...seed,
        [field]: field === "TlsPolicy" ? "Optional" : field === "ScanEnabled" ? false : [],
      } as ReceiptRule;
      const c = client(changed);
      await expect(
        appendMailboxReceivingRecipients(c, config, ["luna@example.com"]),
      ).rejects.toThrow("rule_changed");
      expect(c.commands).toHaveLength(1);
    },
  );
  it("rejects catch-all, aliases and non-exact input", async () => {
    for (const recipient of [
      "example.com",
      "luna+alias@example.com",
      "Luna@example.com",
      "x@bad..example.com",
    ]) {
      const c = client();
      await expect(appendMailboxReceivingRecipients(c, config, [recipient])).rejects.toThrow(
        "configuration",
      );
      expect(c.commands).toHaveLength(0);
    }
  });
  it("enforces provider capacity before mutation", async () => {
    const c = client({
      ...seed,
      Recipients: Array.from({ length: 100 }, (_, i) => `box${i}@example.com`),
    });
    await expect(appendMailboxReceivingRecipients(c, config, ["luna@example.com"])).rejects.toThrow(
      "capacity",
    );
    expect(c.commands).toHaveLength(1);
  });
  it("reconciles an uncertain successful update without posting again", async () => {
    const c = client(structuredClone(seed), true);
    expect(await appendMailboxReceivingRecipients(c, config, ["luna@example.com"])).toEqual({
      confirmed: true,
      added: 1,
    });
    expect(c.commands.filter((x) => x instanceof UpdateReceiptRuleCommand)).toHaveLength(1);
  });
  it("does not certify an update denied or not applied", async () => {
    const c = client(structuredClone(seed), true, false);
    await expect(appendMailboxReceivingRecipients(c, config, ["luna@example.com"])).rejects.toThrow(
      "unconfirmed",
    );
    expect(c.destroyed).toBe(true);
  });
});
