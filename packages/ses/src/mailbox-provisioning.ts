import { createHash } from "node:crypto";
import {
  DescribeActiveReceiptRuleSetCommand,
  type ReceiptRule,
  SESClient,
  UpdateReceiptRuleCommand,
} from "@aws-sdk/client-ses";

export interface MailboxProvisioningRule {
  ruleName: string;
  protectedRuleSha256: string;
}
/** Version 2 pins several exact-address rules of one rule set; version 1 pins one. */
export type MailboxProvisioningConfiguration =
  | ({ version: 1; region: "us-east-1"; ruleSetName: string } & MailboxProvisioningRule)
  | { version: 2; region: "us-east-1"; ruleSetName: string; rules: MailboxProvisioningRule[] };
/** SES limits: 100 recipients per rule and 200 rules per rule set. */
const RECIPIENTS_PER_RULE = 100;
const RULES_PER_SET = 200;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[a-f0-9]{64}$/;
export class MailboxProvisioningError extends Error {
  constructor(public readonly code: "configuration" | "rule_changed" | "capacity" | "unconfirmed") {
    super(code);
  }
}
export function parseMailboxProvisioningConfiguration(
  value: string | undefined,
): MailboxProvisioningConfiguration | null {
  if (!value) return null;
  try {
    const x = JSON.parse(value);
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error();
    const keys = Object.keys(x).sort().join(",");
    if (x.region !== "us-east-1" || typeof x.ruleSetName !== "string" || !NAME.test(x.ruleSetName))
      throw new Error();
    if (x.version === 1) {
      if (
        keys !== "protectedRuleSha256,region,ruleName,ruleSetName,version" ||
        typeof x.ruleName !== "string" ||
        !NAME.test(x.ruleName) ||
        typeof x.protectedRuleSha256 !== "string" ||
        !SHA.test(x.protectedRuleSha256)
      )
        throw new Error();
      return x;
    }
    if (
      x.version !== 2 ||
      keys !== "region,ruleSetName,rules,version" ||
      !Array.isArray(x.rules) ||
      !x.rules.length ||
      x.rules.length > RULES_PER_SET ||
      !x.rules.every(
        (rule: unknown) =>
          !!rule &&
          typeof rule === "object" &&
          !Array.isArray(rule) &&
          Object.keys(rule).sort().join(",") === "protectedRuleSha256,ruleName" &&
          typeof (rule as MailboxProvisioningRule).ruleName === "string" &&
          NAME.test((rule as MailboxProvisioningRule).ruleName) &&
          typeof (rule as MailboxProvisioningRule).protectedRuleSha256 === "string" &&
          SHA.test((rule as MailboxProvisioningRule).protectedRuleSha256),
      ) ||
      new Set(x.rules.map((rule: MailboxProvisioningRule) => rule.ruleName)).size !== x.rules.length
    )
      throw new Error();
    return x;
  } catch {
    throw new MailboxProvisioningError("configuration");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const x = value as Record<string, unknown>;
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
/** Recipients are the only mutable property. All actions and security switches are pinned. */
export function mailboxProtectedRuleSha256(rule: ReceiptRule): string {
  const { Recipients: _, ...protectedRule } = rule;
  return createHash("sha256").update(canonical(protectedRule)).digest("hex");
}
export interface MailboxProvisioningClient {
  send(command: DescribeActiveReceiptRuleSetCommand | UpdateReceiptRuleCommand): Promise<unknown>;
  destroy?(): void;
}
export function createMailboxProvisioningClient(options: {
  region: "us-east-1";
  accessKeyId?: string;
  secretAccessKey?: string;
}): MailboxProvisioningClient {
  return new SESClient({
    region: options.region,
    maxAttempts: 1,
    ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 },
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });
}
function address(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    value === value.toLowerCase() &&
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value) &&
    !value.includes("..") &&
    value.split("@")[1]?.includes(".") === true
  );
}
function pinnedRules(config: MailboxProvisioningConfiguration): MailboxProvisioningRule[] {
  return config.version === 1
    ? [{ ruleName: config.ruleName, protectedRuleSha256: config.protectedRuleSha256 }]
    : config.rules;
}
/** The active set must contain exactly the pinned rules, each unchanged except recipients,
 * and no address may be routed by two rules (SES would run both rules' actions). */
function verifiedRules(
  output: unknown,
  config: MailboxProvisioningConfiguration,
): (ReceiptRule & { Name: string; Recipients: string[] })[] {
  const x = output as { Metadata?: { Name?: string }; Rules?: ReceiptRule[] } | null;
  const pinned = pinnedRules(config);
  if (
    x?.Metadata?.Name !== config.ruleSetName ||
    !Array.isArray(x.Rules) ||
    x.Rules.length !== pinned.length
  )
    throw new MailboxProvisioningError("rule_changed");
  const rules = pinned.map((pin) => {
    const matching = x.Rules?.filter((r) => r.Name === pin.ruleName) ?? [];
    const rule = matching[0];
    if (
      matching.length !== 1 ||
      !rule ||
      rule.Enabled !== true ||
      rule.TlsPolicy !== "Require" ||
      rule.ScanEnabled !== true ||
      !Array.isArray(rule.Recipients) ||
      !rule.Recipients.length ||
      rule.Recipients.length > RECIPIENTS_PER_RULE ||
      !rule.Recipients.every(address) ||
      new Set(rule.Recipients).size !== rule.Recipients.length ||
      mailboxProtectedRuleSha256(rule) !== pin.protectedRuleSha256
    )
      throw new MailboxProvisioningError("rule_changed");
    return { ...rule, Name: pin.ruleName, Recipients: rule.Recipients };
  });
  const all = rules.flatMap((rule) => rule.Recipients);
  if (new Set(all).size !== all.length) throw new MailboxProvisioningError("rule_changed");
  return rules;
}
/** Caller must hold the shared PostgreSQL provisioning lock. Never removes recipients. */
export async function appendMailboxReceivingRecipients(
  client: MailboxProvisioningClient,
  config: MailboxProvisioningConfiguration,
  recipients: readonly string[],
): Promise<{ confirmed: true; added: number }> {
  try {
    if (
      !recipients.length ||
      !recipients.every(address) ||
      new Set(recipients).size !== recipients.length
    )
      throw new MailboxProvisioningError("configuration");
    const original = verifiedRules(
      await client.send(new DescribeActiveReceiptRuleSetCommand({})),
      config,
    );
    const present = new Set(original.flatMap((rule) => rule.Recipients));
    const pending = [...new Set(recipients)].filter((x) => !present.has(x)).sort();
    if (!pending.length) return { confirmed: true, added: 0 };
    // Fill the pinned rules in order; capacity is checked before any mutation.
    const updates: (ReceiptRule & { Recipients: string[] })[] = [];
    for (const rule of original) {
      if (!pending.length) break;
      const room = RECIPIENTS_PER_RULE - rule.Recipients.length;
      if (room <= 0) continue;
      const taken = pending.splice(0, room);
      updates.push({ ...rule, Recipients: [...rule.Recipients, ...taken].sort() });
    }
    if (pending.length) throw new MailboxProvisioningError("capacity");
    // An uncertain mutation is reconciled by a read; no automatic mutation retry.
    for (const rule of updates) {
      try {
        await client.send(
          new UpdateReceiptRuleCommand({ RuleSetName: config.ruleSetName, Rule: rule }),
        );
      } catch {
        /* reconciliation below is authoritative */
      }
    }
    const after = new Set(
      verifiedRules(await client.send(new DescribeActiveReceiptRuleSetCommand({})), config).flatMap(
        (rule) => rule.Recipients,
      ),
    );
    const wanted = [...new Set(recipients)];
    if (!wanted.every((x) => after.has(x))) throw new MailboxProvisioningError("unconfirmed");
    return { confirmed: true, added: wanted.filter((x) => !present.has(x)).length };
  } finally {
    client.destroy?.();
  }
}
