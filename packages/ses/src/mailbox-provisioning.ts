import { createHash } from "node:crypto";
import {
  DescribeActiveReceiptRuleSetCommand,
  type ReceiptRule,
  SESClient,
  UpdateReceiptRuleCommand,
} from "@aws-sdk/client-ses";

export interface MailboxProvisioningConfiguration {
  version: 1;
  region: "us-east-1";
  ruleSetName: string;
  ruleName: string;
  protectedRuleSha256: string;
}
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
    if (
      !x ||
      Array.isArray(x) ||
      Object.keys(x).sort().join(",") !==
        "protectedRuleSha256,region,ruleName,ruleSetName,version" ||
      x.version !== 1 ||
      x.region !== "us-east-1" ||
      ![x.ruleName, x.ruleSetName].every(
        (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s),
      ) ||
      typeof x.protectedRuleSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(x.protectedRuleSha256)
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
function verifiedRule(
  output: unknown,
  config: MailboxProvisioningConfiguration,
): ReceiptRule & { Recipients: string[] } {
  const x = output as { Metadata?: { Name?: string }; Rules?: ReceiptRule[] } | null;
  const matching = x?.Rules?.filter((r) => r.Name === config.ruleName);
  const rule = matching?.[0];
  if (
    x?.Metadata?.Name !== config.ruleSetName ||
    x.Rules?.length !== 1 ||
    matching?.length !== 1 ||
    !rule ||
    rule.Enabled !== true ||
    rule.TlsPolicy !== "Require" ||
    rule.ScanEnabled !== true ||
    !Array.isArray(rule.Recipients) ||
    !rule.Recipients.length ||
    rule.Recipients.length > 100 ||
    !rule.Recipients.every(address) ||
    new Set(rule.Recipients).size !== rule.Recipients.length ||
    mailboxProtectedRuleSha256(rule) !== config.protectedRuleSha256
  )
    throw new MailboxProvisioningError("rule_changed");
  return { ...rule, Recipients: rule.Recipients };
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
    const original = verifiedRule(
      await client.send(new DescribeActiveReceiptRuleSetCommand({})),
      config,
    );
    const union = [...new Set([...original.Recipients, ...recipients])].sort();
    if (union.length > 100) throw new MailboxProvisioningError("capacity");
    const added = union.length - original.Recipients.length;
    if (!added) return { confirmed: true, added: 0 };
    // An uncertain mutation is reconciled by a read; no automatic mutation retry.
    try {
      await client.send(
        new UpdateReceiptRuleCommand({
          RuleSetName: config.ruleSetName,
          Rule: { ...original, Recipients: union },
        }),
      );
    } catch {
      /* reconciliation below is authoritative */
    }
    const after = verifiedRule(
      await client.send(new DescribeActiveReceiptRuleSetCommand({})),
      config,
    );
    if (!union.every((x) => after.Recipients.includes(x)))
      throw new MailboxProvisioningError("unconfirmed");
    return { confirmed: true, added };
  } finally {
    client.destroy?.();
  }
}
