/**
 * The migration assistant: bring the addresses (and, later, the messages) of
 * an account hosted elsewhere into Correio. Pure helpers and the contract
 * agreed with the server on 2026-10-09 (tRPC router `mailboxes.migration`:
 * connect, status, plan, apply, mxReadiness; import and forget come later).
 * The component in app/(dashboard)/mailboxes/mailbox-migration.tsx renders
 * them; the server's `plan` stays the authority, the summary here is a preview.
 */

import { mailboxSetupLocalPart } from "./mailbox-setup";

export type MigrationProviderId = "purelymail" | "titan" | "gmail" | "outlook" | "imap";

export type MigrationProvider = {
  id: MigrationProviderId;
  /** IMAP host; empty for the generic provider, where the user types it. */
  host: string;
  port: number;
  /** The provider only accepts an app password, never the account password. */
  appPassword: boolean;
};

export const MIGRATION_PROVIDERS: readonly MigrationProvider[] = [
  { id: "purelymail", host: "imap.purelymail.com", port: 993, appPassword: false },
  { id: "titan", host: "imap.titan.email", port: 993, appPassword: false },
  { id: "gmail", host: "imap.gmail.com", port: 993, appPassword: true },
  { id: "outlook", host: "outlook.office365.com", port: 993, appPassword: true },
  { id: "imap", host: "", port: 993, appPassword: false },
];

const GENERIC_PROVIDER: MigrationProvider = { id: "imap", host: "", port: 993, appPassword: false };

export function providerPreset(id: MigrationProviderId): MigrationProvider {
  return MIGRATION_PROVIDERS.find((entry) => entry.id === id) ?? GENERIC_PROVIDER;
}

/** `connect`: one IMAP LOGIN + LIST; the password never leaves the request. */
export type MigrationConnectInput = {
  provider: MigrationProviderId;
  host: string;
  port: number;
  secure: true;
  username: string;
  password: string;
};

export type MigrationSource = { sourceId: string; folders: string[] };

export type MigrationPhase = "connected" | "scanning" | "scanned" | "failed";

/** One recipient address on a domain of the source or of the team. */
export type DiscoveredAddress = {
  address: string;
  domain: string;
  localPart: string;
  messages: number;
  lastSeenAt: Date | string | null;
  inMepMail: "mailbox" | "alias" | null;
  mailboxId: string | null;
};

export type MigrationStatus = {
  sourceId: string;
  phase: MigrationPhase;
  foldersDone: number;
  foldersTotal: number;
  messagesSeen: number;
  /** The scan stopped at the per-folder ceiling: only the newest messages were read. */
  truncated: boolean;
  /** Mail to other domains is counted, never stored address by address. */
  externalByDomain: { domain: string; messages: number }[];
  addresses: DiscoveredAddress[];
  failure: "reconnect" | "login" | "network" | null;
};

export type PlanAction = "mailbox" | "alias" | "ignore";

export type PlanItem = {
  address: string;
  action: PlanAction;
  /** The mailbox an alias delivers into. */
  mailboxId: string | null;
  /** The owner of a new mailbox. */
  ownerUserId: string | null;
  label: string | null;
};

export type PlanOutcome =
  | "ok"
  | "exists"
  | "ignored"
  | "conflict"
  | "over_alias_cap"
  | "needs_license"
  | "domain_missing"
  | "invalid";

export type PlanResult = { address: string; outcome: PlanOutcome };

export type PlanSummary = {
  results: PlanResult[];
  newMailboxes: number;
  newAliases: number;
  licensesNeeded: number;
};

export type ApplyOutcome = "created_mailbox" | "created_alias" | "skipped" | "failed";

export type ApplyResult = {
  results: { address: string; outcome: ApplyOutcome; id: string | null; reason: string | null }[];
};

export type MxDomainReadiness = {
  domain: string;
  domainId: string | null;
  /** Discovered addresses that still have no mailbox or alias in MepMail. */
  pending: string[];
  /** Mailboxes plus aliases on the domain; each takes one slot of the receipt rule. */
  recipients: number;
  recipientCap: number;
  receivingState: string;
  mx: { exchange: string; priority: number } | null;
};

export type MxReadiness = { domains: MxDomainReadiness[] };

/** The subset of a registry row the assistant needs. */
export type TeamMailbox = {
  id: string;
  address: string;
  label: string;
  ownerUserId: string | null;
};

export type TeamDomain = { id: string; name: string };

export const MAX_ALIASES_PER_MAILBOX = 20;

/** Addresses with mail in this window are selected by default. */
export const RECENT_MONTHS = 12;

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function recentlyUsed(address: DiscoveredAddress, now: Date): boolean {
  const seen = toDate(address.lastSeenAt);
  if (!seen) return false;
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - RECENT_MONTHS);
  return seen >= limit;
}

export type DomainGroup = {
  domain: string;
  addresses: DiscoveredAddress[];
  messages: number;
  lastSeenAt: Date | null;
};

/** Groups by domain, busiest first; inside a group, busiest address first. */
export function groupByDomain(addresses: readonly DiscoveredAddress[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const entry of addresses) {
    const domain = entry.domain.toLowerCase();
    const group = groups.get(domain) ?? { domain, addresses: [], messages: 0, lastSeenAt: null };
    group.addresses.push(entry);
    group.messages += entry.messages;
    const seen = toDate(entry.lastSeenAt);
    if (seen && (!group.lastSeenAt || seen > group.lastSeenAt)) group.lastSeenAt = seen;
    groups.set(domain, group);
  }
  const byMessages = (a: { messages: number }, b: { messages: number }) => b.messages - a.messages;
  return [...groups.values()]
    .map((group) => ({ ...group, addresses: [...group.addresses].sort(byMessages) }))
    .sort(byMessages);
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export function localPartOf(address: string): string {
  return address.slice(0, address.lastIndexOf("@")).toLowerCase();
}

/**
 * The mailbox an alias on `domain` delivers into by default: the current
 * user's own mailbox on that domain, else the first one on the domain.
 */
export function mainMailboxForDomain(
  domain: string,
  mailboxes: readonly TeamMailbox[],
  currentUserId: string,
): TeamMailbox | null {
  const onDomain = mailboxes.filter((box) => domainOf(box.address) === domain.toLowerCase());
  return onDomain.find((box) => box.ownerUserId === currentUserId) ?? onDomain[0] ?? null;
}

/** A readable label for a new mailbox: "support" → "Support", "jean.silva" → "Jean Silva". */
export function labelFor(localPart: string): string {
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export type DefaultPlan = { items: PlanItem[]; selected: string[] };

/**
 * The starting plan: addresses already in MepMail are listed but untouched;
 * on a domain that already has a mailbox, a discovered address becomes an
 * alias of it; elsewhere it becomes a mailbox owned by the current user.
 * Addresses with mail in the last twelve months start selected.
 */
export function defaultPlan(
  addresses: readonly DiscoveredAddress[],
  mailboxes: readonly TeamMailbox[],
  currentUserId: string,
  now = new Date(),
): DefaultPlan {
  const items: PlanItem[] = [];
  const selected: string[] = [];
  for (const entry of addresses) {
    if (entry.inMepMail) {
      items.push({
        address: entry.address,
        action: "ignore",
        mailboxId: entry.mailboxId,
        ownerUserId: null,
        label: null,
      });
      continue;
    }
    const main = mainMailboxForDomain(entry.domain, mailboxes, currentUserId);
    items.push({
      address: entry.address,
      action: main ? "alias" : "mailbox",
      mailboxId: main?.id ?? null,
      ownerUserId: currentUserId,
      label: labelFor(entry.localPart),
    });
    if (recentlyUsed(entry, now)) selected.push(entry.address);
  }
  return { items, selected };
}

export type PlanContext = {
  addresses: readonly DiscoveredAddress[];
  mailboxes: readonly TeamMailbox[];
  domains: readonly TeamDomain[];
  /** Existing aliases per mailbox id. */
  aliasCounts: Readonly<Record<string, number>>;
  /** Free mailbox seats on the license, or null when seats are unlimited. */
  seatsAvailable: number | null;
};

/**
 * A client-side preview of what `apply` would do with the selected items. The
 * server's `plan` repeats these checks with the database as the authority.
 */
export function planSummary(
  items: readonly PlanItem[],
  selected: ReadonlySet<string>,
  context: PlanContext,
): PlanSummary {
  const known = new Map(context.addresses.map((entry) => [entry.address, entry]));
  const domainNames = new Set(context.domains.map((domain) => domain.name.toLowerCase()));
  const aliasLoad = new Map<string, number>(Object.entries(context.aliasCounts));
  const taken = new Set(context.mailboxes.map((box) => box.address.toLowerCase()));
  const results: PlanResult[] = [];
  let newMailboxes = 0;
  let newAliases = 0;
  for (const item of items) {
    const entry = known.get(item.address);
    if (entry?.inMepMail) {
      results.push({ address: item.address, outcome: "exists" });
      continue;
    }
    if (!selected.has(item.address) || item.action === "ignore") {
      results.push({ address: item.address, outcome: "ignored" });
      continue;
    }
    const domain = domainOf(item.address);
    const local = mailboxSetupLocalPart(localPartOf(item.address));
    if (!local) {
      results.push({ address: item.address, outcome: "invalid" });
      continue;
    }
    if (!domainNames.has(domain)) {
      results.push({ address: item.address, outcome: "domain_missing" });
      continue;
    }
    if (taken.has(item.address.toLowerCase())) {
      results.push({ address: item.address, outcome: "conflict" });
      continue;
    }
    taken.add(item.address.toLowerCase());
    if (item.action === "alias") {
      const target = item.mailboxId
        ? context.mailboxes.find((box) => box.id === item.mailboxId)
        : null;
      if (!target || domainOf(target.address) !== domain) {
        results.push({ address: item.address, outcome: "invalid" });
        continue;
      }
      const load = (aliasLoad.get(target.id) ?? 0) + 1;
      aliasLoad.set(target.id, load);
      if (load > MAX_ALIASES_PER_MAILBOX) {
        results.push({ address: item.address, outcome: "over_alias_cap" });
        continue;
      }
      newAliases += 1;
      results.push({ address: item.address, outcome: "ok" });
      continue;
    }
    newMailboxes += 1;
    results.push({ address: item.address, outcome: "ok" });
  }
  const licensesNeeded =
    context.seatsAvailable === null ? 0 : Math.max(0, newMailboxes - context.seatsAvailable);
  if (licensesNeeded > 0) {
    // The last mailboxes planned are the ones without a seat.
    let short = licensesNeeded;
    for (let index = results.length - 1; index >= 0 && short > 0; index -= 1) {
      const item = items[index];
      const result = results[index];
      if (item && result?.outcome === "ok" && item.action === "mailbox") {
        results[index] = { address: item.address, outcome: "needs_license" };
        short -= 1;
      }
    }
  }
  return { results, newMailboxes, newAliases, licensesNeeded };
}

/** The items `apply` receives: the selected ones that the preview accepted. */
export function applicableItems(items: readonly PlanItem[], summary: PlanSummary): PlanItem[] {
  const accepted = new Set(
    summary.results.filter((result) => result.outcome === "ok").map((result) => result.address),
  );
  return items.filter((item) => accepted.has(item.address));
}
