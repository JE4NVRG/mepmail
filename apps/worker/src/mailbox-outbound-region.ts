import { SES_REGIONS } from "@millionsend/ses";

export interface MailboxSesOutboundRegion {
  readonly teamId: string;
  readonly domainId: string;
  readonly domain: string;
  readonly region: string;
}
export type MailboxSesOutboundRegions = readonly MailboxSesOutboundRegion[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Exact operator bindings, never a wildcard, user preference or automatic failover. */
export function copyMailboxSesOutboundRegions(value: unknown): MailboxSesOutboundRegions {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("mailbox_ses_outbound_regions_invalid");
  const ids = new Set<string>();
  const names = new Set<string>();
  return Object.freeze(
    value.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("mailbox_ses_outbound_regions_invalid");
      const row = item as Record<string, unknown>;
      if (
        Object.keys(row).sort().join(",") !== "domain,domainId,region,teamId" ||
        typeof row.teamId !== "string" ||
        !UUID.test(row.teamId) ||
        typeof row.domainId !== "string" ||
        !UUID.test(row.domainId) ||
        typeof row.domain !== "string" ||
        !DOMAIN.test(row.domain) ||
        typeof row.region !== "string" ||
        !SES_REGIONS.some((region) => region === row.region) ||
        ids.has(row.domainId) ||
        names.has(`${row.teamId}|${row.domain}`)
      )
        throw new Error("mailbox_ses_outbound_regions_invalid");
      ids.add(row.domainId);
      names.add(`${row.teamId}|${row.domain}`);
      return Object.freeze({
        teamId: row.teamId,
        domainId: row.domainId,
        domain: row.domain,
        region: row.region,
      });
    }),
  );
}

export function parseMailboxSesOutboundRegions(value?: string): MailboxSesOutboundRegions {
  if (value === undefined || value.trim() === "") return Object.freeze([]);
  if (Buffer.byteLength(value) > 64 * 1024) throw new Error("mailbox_ses_outbound_regions_invalid");
  try {
    const parsed: unknown = JSON.parse(value);
    // JSON.parse discards duplicate keys. Inspect original tokens, decoding keys
    // so escaped equivalents cannot silently override an operator binding.
    const tokens = value.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) ?? [];
    const stack: Array<Set<string> | null> = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "{") stack.push(new Set());
      else if (token === "[") stack.push(null);
      else if (token === "}" || token === "]") stack.pop();
      else if (token.startsWith('"') && tokens[i + 1] === ":") {
        const keys = stack.at(-1);
        const key = JSON.parse(token) as string;
        if (!keys || keys.has(key)) throw new Error("duplicate_key");
        keys.add(key);
      }
    }
    return copyMailboxSesOutboundRegions(parsed);
  } catch {
    // Never echo private operator bindings in startup logs.
    throw new Error("mailbox_ses_outbound_regions_invalid");
  }
}

export function resolveMailboxSesOutboundRegion(
  entries: MailboxSesOutboundRegions,
  bound: { teamId: string; domainId: string; domain: string; region: string },
): string {
  const entry = entries.find(
    (row) =>
      row.domainId === bound.domainId ||
      (row.teamId === bound.teamId && row.domain === bound.domain),
  );
  if (!entry) return bound.region;
  if (
    entry.teamId !== bound.teamId ||
    entry.domainId !== bound.domainId ||
    entry.domain !== bound.domain
  )
    throw new Error("mailbox_ses_outbound_region_binding");
  return entry.region;
}

/** Controls include explicit outbound destinations without enabling domain creation/inbound there. */
export function mailboxSesControlRegions(
  regions: readonly string[],
  outbound: MailboxSesOutboundRegions,
  failoverRegion?: string,
): string[] {
  return [
    ...new Set([
      ...regions,
      ...(failoverRegion ? [failoverRegion] : []),
      ...outbound.map((row) => row.region),
    ]),
  ];
}

/** Activation requires a trusted evidence channel in each explicit destination. */
export function assertMailboxSesOutboundTopics(
  entries: MailboxSesOutboundRegions,
  topics: readonly string[],
): void {
  const covered = new Set(
    topics.flatMap((topic) => {
      const match = /^arn:aws(?:-us-gov|-cn)?:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]+$/.exec(topic);
      return match ? [match[1]!] : [];
    }),
  );
  if (entries.some((entry) => !covered.has(entry.region)))
    throw new Error("mailbox_ses_outbound_evidence_topic_missing");
}

/** Unknown or stale operator records abort activation rather than silently falling back. */
export async function assertMailboxSesOutboundBindings(
  entries: MailboxSesOutboundRegions,
  lookup: (
    ids: string[],
  ) => Promise<readonly { domainId: string; teamId: string; domain: string }[]>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const rows = await lookup(entries.map((entry) => entry.domainId));
    if (
      rows.length !== entries.length ||
      entries.some(
        (entry) =>
          !rows.some(
            (row) =>
              row.domainId === entry.domainId &&
              row.teamId === entry.teamId &&
              row.domain === entry.domain,
          ),
      )
    )
      throw new Error("binding");
  } catch {
    throw new Error("mailbox_ses_outbound_region_binding");
  }
}
