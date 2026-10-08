import type { Keyring, MailboxTransportMimeAdapter } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import {
  createMailboxPrivateObjectReader,
  type MailboxPrivateObjectLocation,
} from "../../../packages/ses/src/mailbox-storage.js";
import { createMailboxEvidenceHandler } from "./mailbox-evidence.js";
import {
  createMailboxReceiver,
  isMailboxReceipt,
  MailboxProviderEventError,
  type TrustedMailboxNotification,
} from "./mailbox-receiver.js";
import type { SesFailover } from "./ses-failover.js";

export interface MailboxInboundConfiguration {
  region: string;
  topics: string[];
  locations: MailboxPrivateObjectLocation[];
}

/** Operator-owned private S3 receipt configuration; absent keeps ingress off. */
export function parseMailboxInboundConfiguration(
  value: string | undefined,
): MailboxInboundConfiguration | null {
  if (!value?.trim()) return null;
  try {
    const raw = JSON.parse(value);
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "locations,region,topics" ||
      typeof raw.region !== "string" ||
      !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(raw.region) ||
      !Array.isArray(raw.topics) ||
      !raw.topics.length ||
      raw.topics.length > 8 ||
      !Array.isArray(raw.locations) ||
      !raw.locations.length ||
      raw.locations.length > 8
    )
      throw new Error();
    const accounts = new Set<string>();
    for (const topic of raw.topics) {
      const match =
        typeof topic === "string"
          ? /^arn:aws(?:-us-gov|-cn)?:sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_-]+$/.exec(topic)
          : null;
      if (!match || match[1] !== raw.region) throw new Error();
      accounts.add(match[2]!);
    }
    if (new Set(raw.topics).size !== raw.topics.length || accounts.size !== 1) throw new Error();
    const locations: MailboxPrivateObjectLocation[] = raw.locations.map((location: unknown) => {
      const item = location as MailboxPrivateObjectLocation;
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "bucket,ownerAccountId,prefix" ||
        typeof item.bucket !== "string" ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(item.bucket) ||
        typeof item.prefix !== "string" ||
        !item.prefix.endsWith("/") ||
        Buffer.byteLength(item.prefix) > 512 ||
        /[\u0000-\u001f\u007f\\]/.test(item.prefix) ||
        item.prefix.startsWith("/") ||
        item.prefix.split("/").some((part) => part === "." || part === "..") ||
        typeof item.ownerAccountId !== "string" ||
        !accounts.has(item.ownerAccountId)
      )
        throw new Error();
      return { bucket: item.bucket, prefix: item.prefix, ownerAccountId: item.ownerAccountId };
    });
    if (new Set(locations.map((l) => `${l.bucket}:${l.prefix}`)).size !== locations.length)
      throw new Error();
    return { region: raw.region, topics: [...raw.topics], locations };
  } catch {
    // Do not echo configuration or private object locations into startup logs.
    throw new Error("Invalid private mailbox inbound configuration");
  }
}

/** One dispatcher on the existing authenticated SQS consumer. No public ingress. */
export function createMailboxIngress(options: {
  db: Db;
  keys: Keyring;
  mime: MailboxTransportMimeAdapter;
  enabled: boolean;
  eventTopics: readonly string[];
  inbound: MailboxInboundConfiguration | null;
  failover?: SesFailover | undefined;
}) {
  const evidence = createMailboxEvidenceHandler({ ...options, topics: options.eventTopics });
  const inbound = options.inbound;
  const receiver =
    inbound && options.enabled
      ? createMailboxReceiver({
          ...options,
          topics: inbound.topics,
          locations: inbound.locations,
          reader: createMailboxPrivateObjectReader({
            region: inbound.region,
            locations: inbound.locations,
          }),
        })
      : null;
  return {
    allowedTopicArns: [...new Set([...options.eventTopics, ...(inbound?.topics ?? [])])],
    async dispatch(input: TrustedMailboxNotification): Promise<boolean> {
      if (isMailboxReceipt(input.event)) {
        if (!receiver) throw new MailboxProviderEventError("disabled");
        return receiver(input);
      }
      return evidence(input);
    },
  };
}
