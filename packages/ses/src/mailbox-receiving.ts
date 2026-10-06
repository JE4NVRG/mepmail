import { DescribeActiveReceiptRuleSetCommand, SESClient } from "@aws-sdk/client-ses";
import { GetEmailIdentityCommand, SESv2Client } from "@aws-sdk/client-sesv2";

export interface MailboxReceivingRoute {
  region: string;
  topics: readonly string[];
  locations: readonly { bucket: string; prefix: string; ownerAccountId: string }[];
}
export interface MailboxReceivingRuleClient {
  send(command: DescribeActiveReceiptRuleSetCommand): Promise<unknown>;
  destroy?(): void;
}

/** Reads existing receiving configuration. Never creates, enables or changes rules. */
export function createMailboxReceivingRuleClient(options: {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): MailboxReceivingRuleClient {
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

export async function readMailboxReceivingRules(
  client: MailboxReceivingRuleClient,
): Promise<unknown> {
  try {
    return await client.send(new DescribeActiveReceiptRuleSetCommand({}));
  } finally {
    client.destroy?.();
  }
}

export interface MailboxReceivingRuleFacts {
  ruleSetActive: boolean;
  ruleEnabled: boolean;
  tlsRequired: boolean;
  scanEnabled: boolean;
  /** Compatibility flags certify configured routes, not resource permissions. */
  storageReady: boolean;
  notificationReady: boolean;
  storageRouteMatched: boolean;
  notificationRouteMatched: boolean;
  /** DescribeActiveReceiptRuleSet does not read bucket/topic/role permissions. */
  resourcePermissionsVerified: false;
  recipients: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function host(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253 || value !== value.trim()) return null;
  const normalized = value.toLowerCase();
  return normalized.includes(".") &&
    normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? normalized
    : null;
}

function recipient(
  value: unknown,
): { domain: string; address: string | null; subdomains: boolean } | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  const at = normalized.indexOf("@");
  if (at >= 0) {
    const local = normalized.slice(0, at);
    const domain = host(normalized.slice(at + 1));
    if (
      !domain ||
      local.length > 64 ||
      !/^[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+)*$/.test(local)
    )
      return null;
    return { domain, address: normalized, subdomains: false };
  }
  const subdomains = normalized.startsWith(".");
  const domain = host(subdomains ? normalized.slice(1) : normalized);
  return domain ? { domain, address: null, subdomains } : null;
}

/** SES: a plain domain matches only itself; a leading dot matches only its children. */
function matchesDomain(
  condition: NonNullable<ReturnType<typeof recipient>>,
  domain: string,
): boolean {
  return condition.subdomains
    ? domain.endsWith(`.${condition.domain}`)
    : condition.domain === domain;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function routeValid(config: MailboxReceivingRoute): boolean {
  if (
    !config ||
    typeof config.region !== "string" ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.region) ||
    !Array.isArray(config.topics) ||
    !config.topics.length ||
    config.topics.length > 8 ||
    !Array.isArray(config.locations) ||
    !config.locations.length ||
    config.locations.length > 8
  )
    return false;
  const partition = config.region.startsWith("cn-")
    ? "aws-cn"
    : config.region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const accounts = new Set<string>();
  for (const topic of config.topics) {
    const match =
      typeof topic === "string"
        ? /^arn:(aws(?:-us-gov|-cn)?):sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_-]+$/.exec(topic)
        : null;
    if (!match || match[1] !== partition || match[2] !== config.region) return false;
    accounts.add(match[3] ?? "");
  }
  if (accounts.size !== 1 || new Set(config.topics).size !== config.topics.length) return false;
  for (const location of config.locations) {
    if (
      !location ||
      typeof location.bucket !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(location.bucket) ||
      typeof location.prefix !== "string" ||
      !location.prefix.endsWith("/") ||
      Buffer.byteLength(location.prefix) > 512 ||
      [...location.prefix].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 || code === 92;
      }) ||
      location.prefix.startsWith("/") ||
      location.prefix.split("/").some((part: string) => part === "." || part === "..") ||
      typeof location.ownerAccountId !== "string" ||
      !accounts.has(location.ownerAccountId)
    )
      return false;
  }
  return (
    new Set(config.locations.map((location) => `${location.bucket}:${location.prefix}`)).size ===
    config.locations.length
  );
}

/** Every matching enabled rule must have an approved S3 notification route.
 * Both earlier and later conflicting rules prevent certification. SES implicitly
 * matches plus labels; only explicitly declared RCPT addresses are returned here.
 */
export function mailboxReceivingRuleFacts(
  output: unknown,
  domain: string,
  config: MailboxReceivingRoute,
): MailboxReceivingRuleFacts {
  const input = record(output);
  const metadata = record(input?.Metadata);
  const empty: MailboxReceivingRuleFacts = {
    ruleSetActive: false,
    ruleEnabled: false,
    tlsRequired: false,
    scanEnabled: false,
    storageReady: false,
    notificationReady: false,
    storageRouteMatched: false,
    notificationRouteMatched: false,
    resourcePermissionsVerified: false,
    recipients: [],
  };
  if (typeof metadata?.Name !== "string" || !metadata.Name.trim() || !Array.isArray(input?.Rules))
    return empty;
  const active = { ...empty, ruleSetActive: true };
  const normalizedDomain = host(domain);
  if (!normalizedDomain || !routeValid(config)) return active;
  const recipients = new Set<string>();
  for (const value of input.Rules) {
    const rule = record(value);
    if (!rule || typeof rule.Enabled !== "boolean") return active;
    if (!rule.Enabled) continue;
    if (rule.Recipients !== undefined && !Array.isArray(rule.Recipients)) return active;
    const conditions = (rule.Recipients ?? []) as unknown[];
    if (!conditions.length) return { ...active, ruleEnabled: true };
    if (conditions.length > 100) return active;
    const parsed = conditions.map(recipient);
    if (parsed.some((condition) => !condition)) return active;
    const relevant = parsed.filter(
      (condition) => condition && matchesDomain(condition, normalizedDomain),
    );
    if (!relevant.length) continue;
    const unsafe = { ...active, ruleEnabled: true };
    if (relevant.some((condition) => !condition?.address)) return unsafe;
    const actions = Array.isArray(rule.Actions) ? rule.Actions : [];
    const first = record(actions[0]);
    const second = record(actions[1]);
    const location = record(first?.S3Action);
    const topic = record(second?.SNSAction);
    const role = location?.IamRoleArn;
    const owner = config.locations[0]?.ownerAccountId;
    const partition = config.topics[0]?.split(":")[1];
    const validRole =
      role === undefined ||
      (typeof role === "string" &&
        role.length <= 2048 &&
        new RegExp(`^arn:${partition}:iam::${owner}:role/[A-Za-z0-9_+=,.@/-]+$`).test(role));
    const stored =
      (actions.length === 1 || actions.length === 2) &&
      !!first &&
      onlyKeys(first, ["S3Action"]) &&
      !!location &&
      onlyKeys(location, [
        "BucketName",
        "ObjectKeyPrefix",
        "TopicArn",
        "IamRoleArn",
        "KmsKeyArn",
      ]) &&
      location.KmsKeyArn === undefined &&
      validRole &&
      config.locations.some(
        (expected) =>
          expected.bucket === location.BucketName &&
          expected.prefix === (location.ObjectKeyPrefix ?? ""),
      );
    const notified =
      typeof location?.TopicArn === "string" &&
      config.topics.includes(location.TopicArn) &&
      (actions.length === 1 ||
        (!!second &&
          onlyKeys(second, ["SNSAction"]) &&
          !!topic &&
          onlyKeys(topic, ["TopicArn", "Encoding"]) &&
          typeof topic.TopicArn === "string" &&
          config.topics.includes(topic.TopicArn) &&
          (topic.Encoding === undefined ||
            topic.Encoding === "UTF-8" ||
            topic.Encoding === "Base64")));
    if (rule.TlsPolicy !== "Require" || rule.ScanEnabled !== true || !stored || !notified)
      return unsafe;
    for (const condition of relevant) {
      if (condition?.address) recipients.add(condition.address);
    }
  }
  if (!recipients.size) return active;
  return {
    ruleSetActive: true,
    ruleEnabled: true,
    tlsRequired: true,
    scanEnabled: true,
    storageReady: true,
    notificationReady: true,
    storageRouteMatched: true,
    notificationRouteMatched: true,
    resourcePermissionsVerified: false,
    recipients: [...recipients].sort(),
  };
}

export async function mailboxReceivingIdentityVerified(options: {
  region: string;
  domain: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): Promise<boolean> {
  const client = new SESv2Client({
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
  try {
    const value = await client.send(new GetEmailIdentityCommand({ EmailIdentity: options.domain }));
    return value.VerifiedForSendingStatus === true;
  } finally {
    client.destroy();
  }
}
