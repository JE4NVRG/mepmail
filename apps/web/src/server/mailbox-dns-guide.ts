import { resolveMx, resolveNs } from "node:dns/promises";

/**
 * The receiving (MX) guide beside a Correio domain: which DNS host serves the
 * zone, what the MX records point at today and the exact record to add. Only
 * public DNS is read; nothing is written anywhere. The activation decision
 * stays with the receiving readiness check, which this never replaces.
 */

export const DNS_PROVIDERS = [
  "cloudflare",
  "registrobr",
  "godaddy",
  "route53",
  "hostinger",
  "locaweb",
  "other",
] as const;
export type DnsProvider = (typeof DNS_PROVIDERS)[number];

const NAMESERVER_HOSTS: [RegExp, DnsProvider][] = [
  [/\.ns\.cloudflare\.com$/, "cloudflare"],
  [/(^|\.)dns\.br$/, "registrobr"],
  [/\.domaincontrol\.com$/, "godaddy"],
  [/\.awsdns-\d+\.(com|net|org|co\.uk)$/, "route53"],
  [/\.dns-parking\.com$|\.hostinger\.(com|com\.br|io)$/, "hostinger"],
  [/\.locaweb\.com\.br$/, "locaweb"],
];

/** Who receives the domain's mail today, named only for the hosts we recognise. */
const MAIL_HOSTS: [RegExp, string][] = [
  [/(^|\.)(google|googlemail)\.com$/, "Google Workspace"],
  [/\.(protection\.)?outlook\.com$/, "Microsoft 365"],
  [/\.purelymail\.com$/, "Purelymail"],
  [/\.titan\.email$/, "Titan"],
  [/\.zoho\.(com|eu|in|com\.au)$/, "Zoho Mail"],
  [/\.mx\.cloudflare\.net$/, "Cloudflare Email Routing"],
  [/\.improvmx\.com$/, "ImprovMX"],
  [/\.forwardemail\.net$/, "Forward Email"],
  [/\.migadu\.com$/, "Migadu"],
  [/\.(messagingengine|fastmail)\.com$/, "Fastmail"],
  [/\.hostinger\.(com|com\.br|io)$/, "Hostinger"],
  [/\.locaweb\.com\.br$/, "Locaweb"],
  [/\.(umbler|kinghost)\.(com|net|com\.br)$/, "hospedagem"],
];

export interface MailboxDnsGuide {
  domain: string;
  /** The zone the record goes in: the domain itself or the parent that holds its NS. */
  zone: string;
  /** The record's name inside that zone: "@" for the zone apex, else the label(s) before it. */
  recordName: string;
  provider: DnsProvider;
  nameservers: string[];
  mx: { exchange: string; priority: 10 };
  current: { exchange: string; priority: number; ours: boolean; provider: string | null }[];
  /** A recognised mailbox provider that receives this domain's mail today, if any. */
  otherProvider: string | null;
}

export interface MailboxDnsGuideDeps {
  resolveNs?: (name: string) => Promise<string[]>;
  resolveMx?: (name: string) => Promise<{ exchange: string; priority: number }[]>;
}

const normal = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

export function dnsProviderFor(nameservers: readonly string[]): DnsProvider {
  for (const ns of nameservers.map(normal)) {
    const hit = NAMESERVER_HOSTS.find(([pattern]) => pattern.test(ns));
    if (hit) return hit[1];
  }
  return "other";
}

export function mailHostProvider(exchange: string): string | null {
  const host = normal(exchange);
  return MAIL_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
}

/** The nearest name at or above `domain` that has NS records (the zone apex). */
async function zoneOf(domain: string, resolve: (name: string) => Promise<string[]>) {
  const labels = domain.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const ns = await resolve(name).catch(() => [] as string[]);
    if (ns.length) return { zone: name, nameservers: ns.map(normal).sort() };
  }
  return { zone: domain, nameservers: [] as string[] };
}

export async function mailboxDnsGuide(
  domainName: string,
  expectedMx: string,
  deps: MailboxDnsGuideDeps = {},
): Promise<MailboxDnsGuide> {
  const domain = normal(domainName);
  const expected = normal(expectedMx);
  const { zone, nameservers } = await zoneOf(domain, deps.resolveNs ?? resolveNs);
  const records = await (deps.resolveMx ?? resolveMx)(domain).catch(
    () => [] as { exchange: string; priority: number }[],
  );
  const current = records
    .map((record) => {
      const exchange = normal(record.exchange);
      return {
        exchange,
        priority: record.priority,
        ours: exchange === expected,
        provider: exchange === expected ? null : mailHostProvider(exchange),
      };
    })
    .sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange));
  const foreign = current.filter((record) => !record.ours);
  return {
    domain,
    zone,
    recordName: domain === zone ? "@" : domain.slice(0, -(zone.length + 1)),
    provider: dnsProviderFor(nameservers),
    nameservers,
    mx: { exchange: expected, priority: 10 },
    current,
    otherProvider: foreign.find((record) => record.provider)?.provider ?? null,
  };
}
