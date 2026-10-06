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

describe("recipient activation across several pinned exact-address rules", () => {
  const rule = (name: string, recipients: string[]): ReceiptRule & { Name: string } => ({
    ...structuredClone(seed),
    Name: name,
    Recipients: recipients,
  });
  const base = [rule("rule-a", ["support@example.com"]), rule("rule-b", ["hold@b.invalid"])];
  const v2 = (rules = base): MailboxProvisioningConfiguration => ({
    version: 2,
    region: "us-east-1",
    ruleSetName: "existing-set",
    rules: rules.map((r) => ({
      ruleName: r.Name,
      protectedRuleSha256: mailboxProtectedRuleSha256(r),
    })),
  });
  function multi(initial = base, failOn: string | null = null) {
    let rules = structuredClone(initial) as ReceiptRule[];
    const commands: unknown[] = [];
    return {
      commands,
      get rules() {
        return rules;
      },
      async send(command: DescribeActiveReceiptRuleSetCommand | UpdateReceiptRuleCommand) {
        commands.push(command);
        if (command instanceof DescribeActiveReceiptRuleSetCommand)
          return { Metadata: { Name: "existing-set" }, Rules: structuredClone(rules) };
        const next = command.input.Rule!;
        if (next.Name === failOn) throw new Error("denied");
        rules = rules.map((r) => (r.Name === next.Name ? structuredClone(next) : r));
        return {};
      },
    };
  }
  const updates = (c: { commands: unknown[] }) =>
    c.commands.filter((x) => x instanceof UpdateReceiptRuleCommand) as UpdateReceiptRuleCommand[];

  it("parses version 2 and rejects ambiguous or oversized pins", () => {
    const config = v2();
    expect(parseMailboxProvisioningConfiguration(JSON.stringify(config))).toEqual(config);
    const bad = [
      { ...config, rules: [] },
      {
        ...config,
        rules: [
          config.version === 2 ? config.rules[0] : null,
          config.version === 2 ? config.rules[0] : null,
        ],
      },
      { ...config, rules: [{ ruleName: "rule-a", protectedRuleSha256: "x" }] },
      { ...config, rules: [{ ruleName: "rule-a", protectedRuleSha256: "a".repeat(64), extra: 1 }] },
      {
        ...config,
        rules: Array.from({ length: 201 }, (_, i) => ({
          ruleName: `r${i}`,
          protectedRuleSha256: "a".repeat(64),
        })),
      },
      { ...config, ruleName: "rule-a" },
      { ...config, version: 3 },
    ];
    for (const value of bad)
      expect(() => parseMailboxProvisioningConfiguration(JSON.stringify(value))).toThrow(
        "configuration",
      );
  });

  it("fills the first rule, then spills over in pinned order, touching only changed rules", async () => {
    const full = Array.from(
      { length: 99 },
      (_, i) => `box${String(i).padStart(2, "0")}@example.com`,
    );
    const start = [rule("rule-a", full), rule("rule-b", ["hold@b.invalid"])];
    const c = multi(start);
    expect(
      await appendMailboxReceivingRecipients(c, v2(start), [
        "new1@example.com",
        "new2@example.com",
      ]),
    ).toEqual({ confirmed: true, added: 2 });
    expect(updates(c).map((u) => [u.input.Rule?.Name, u.input.Rule?.Recipients?.length])).toEqual([
      ["rule-a", 100],
      ["rule-b", 2],
    ]);
    expect(updates(c)[1]?.input.Rule).toEqual({
      ...start[1],
      Recipients: ["hold@b.invalid", "new2@example.com"],
    });
    // Replays are reads only, wherever the address landed.
    expect(
      await appendMailboxReceivingRecipients(c, v2(start), [
        "new1@example.com",
        "new2@example.com",
      ]),
    ).toEqual({ confirmed: true, added: 0 });
    expect(updates(c)).toHaveLength(2);
  });

  it("refuses capacity across all rules before any mutation", async () => {
    const start = [
      rule(
        "rule-a",
        Array.from({ length: 100 }, (_, i) => `a${i}@example.com`),
      ),
      rule(
        "rule-b",
        Array.from({ length: 100 }, (_, i) => `b${i}@example.com`),
      ),
    ];
    const c = multi(start);
    await expect(
      appendMailboxReceivingRecipients(c, v2(start), ["luna@example.com"]),
    ).rejects.toThrow("capacity");
    expect(c.commands).toHaveLength(1);
  });

  it("rejects an unpinned extra rule, a missing rule or an address routed twice", async () => {
    const extra = [...base, rule("rogue", ["x@example.com"])];
    const missing = [base[0]!];
    const twice = [rule("rule-a", ["dup@example.com"]), rule("rule-b", ["dup@example.com"])];
    for (const [live, config] of [
      [extra, v2()],
      [missing, v2()],
      [twice, v2(twice)],
    ] as const) {
      const c = multi(live as (ReceiptRule & { Name: string })[]);
      await expect(
        appendMailboxReceivingRecipients(c, config, ["luna@example.com"]),
      ).rejects.toThrow("rule_changed");
      expect(c.commands).toHaveLength(1);
    }
  });

  it("rejects drift in any pinned rule before mutation", async () => {
    const drifted = [base[0]!, { ...base[1]!, TlsPolicy: "Optional" as const }];
    const c = multi(drifted);
    await expect(appendMailboxReceivingRecipients(c, v2(), ["luna@example.com"])).rejects.toThrow(
      "rule_changed",
    );
    expect(c.commands).toHaveLength(1);
  });

  it("does not certify a partial spill-over and completes it on the next activation", async () => {
    const start = [
      rule(
        "rule-a",
        Array.from({ length: 99 }, (_, i) => `a${i}@example.com`),
      ),
      rule("rule-b", ["hold@b.invalid"]),
    ];
    const failing = multi(start, "rule-b");
    await expect(
      appendMailboxReceivingRecipients(failing, v2(start), ["n1@example.com", "n2@example.com"]),
    ).rejects.toThrow("unconfirmed");
    expect(failing.rules[0]?.Recipients).toContain("n1@example.com");
    const retry = multi(failing.rules as (ReceiptRule & { Name: string })[]);
    expect(
      await appendMailboxReceivingRecipients(retry, v2(start), [
        "n1@example.com",
        "n2@example.com",
      ]),
    ).toEqual({ confirmed: true, added: 1 });
    expect(updates(retry).map((u) => u.input.Rule?.Name)).toEqual(["rule-b"]);
  });
});
