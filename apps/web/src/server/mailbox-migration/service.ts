import { randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import {
  addMailboxAlias,
  createMailboxRegistry,
  getMailboxReceivingReadiness,
  MAX_ALIASES_PER_MAILBOX,
  type MailboxRegistryActor,
  mailboxServiceState,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { mailboxReceivingDeps } from "../mailbox-receiving";
import { ImapError, type ImapOpenDeps, type ImapSession, openImap } from "./imap";
import { type ScanResult, scanAccount, scannableFolders } from "./scan";

/**
 * The migration assistant's server: one IMAP sign-in discovers which addresses
 * of the team's (or the account's) domains actually receive mail, the person
 * picks mailbox / alias / ignore, and apply creates them with the existing
 * registry rules. Nothing is persisted: the password is used for one LOGIN and
 * dropped, and the discovered addresses live in this process for two hours.
 */
export class MigrationError extends Error {
  constructor(
    public readonly code: "login" | "network" | "blocked" | "busy" | "rate_limited" | "not_found",
  ) {
    super(code);
  }
}

type Phase = "connected" | "scanning" | "scanned" | "failed";
interface Source {
  id: string;
  teamId: string;
  userId: string;
  ownDomains: Set<string>;
  phase: Phase;
  failure: "login" | "network" | null;
  result: ScanResult;
  expiresAt: number;
}

const TTL_MS = 2 * 60 * 60 * 1000;
const CONNECTS_PER_HOUR = 10;
const RECIPIENT_CAP = 100;
const sources = new Map<string, Source>();
const connects = new Map<string, number[]>();
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function sweep(now = Date.now()) {
  for (const [id, source] of sources) if (source.expiresAt <= now) sources.delete(id);
}

/** Test hook: forget every in-memory source and rate counter. */
export function resetMigrationState() {
  sources.clear();
  connects.clear();
}

function ownSource(actor: MailboxRegistryActor, sourceId: string): Source | null {
  sweep();
  const source = sources.get(sourceId);
  return source && source.teamId === actor.teamId && source.userId === actor.userId ? source : null;
}

async function teamDomains(db: Db, teamId: string) {
  return db
    .select({ id: schema.domains.id, name: schema.domains.name })
    .from(schema.domains)
    .where(eq(schema.domains.teamId, teamId));
}

export interface ConnectInput {
  provider: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

/** LOGIN + LIST now; the header scan continues in this process while status() is polled. */
export async function connectMigrationSource(
  db: Db,
  actor: MailboxRegistryActor,
  input: ConnectInput,
  deps: ImapOpenDeps & { scan?: typeof scanAccount } = {},
): Promise<{ sourceId: string; folders: string[] }> {
  await withMailboxRegistryAdmin(db, actor, async () => null);
  sweep();
  const now = Date.now();
  const recent = (connects.get(actor.teamId) ?? []).filter((at) => at > now - 3600_000);
  if (recent.length >= CONNECTS_PER_HOUR) throw new MigrationError("rate_limited");
  if ([...sources.values()].some((s) => s.teamId === actor.teamId && s.phase === "scanning"))
    throw new MigrationError("busy");
  connects.set(actor.teamId, [...recent, now]);
  let session: ImapSession;
  try {
    session = await openImap(input, deps);
  } catch (error) {
    const reason = error instanceof ImapError ? error.reason : "network";
    throw new MigrationError(
      reason === "login" ? "login" : reason === "blocked" ? "blocked" : "network",
    );
  }
  const ownDomains = new Set(
    (await teamDomains(db, actor.teamId)).map((d) => d.name.toLowerCase()),
  );
  const accountDomain = input.username.includes("@")
    ? input.username.slice(input.username.lastIndexOf("@") + 1).toLowerCase()
    : null;
  if (accountDomain) ownDomains.add(accountDomain);
  let folders: string[];
  try {
    folders = scannableFolders(await session.list()).map((folder) => folder.display);
  } catch {
    await session.logout();
    throw new MigrationError("network");
  }
  const source: Source = {
    id: randomUUID(),
    teamId: actor.teamId,
    userId: actor.userId,
    ownDomains,
    phase: "scanning",
    failure: null,
    result: {
      foldersDone: 0,
      foldersTotal: folders.length,
      messagesSeen: 0,
      truncated: false,
      addresses: new Map(),
      external: new Map(),
    },
    expiresAt: now + TTL_MS,
  };
  sources.set(source.id, source);
  void (deps.scan ?? scanAccount)(session, {
    ownDomains,
    onProgress: (progress) => {
      source.result = { ...source.result, ...progress };
    },
    cancelled: () => !sources.has(source.id),
  })
    .then((result) => {
      source.result = result;
      source.phase = "scanned";
    })
    .catch((error) => {
      source.phase = "failed";
      source.failure = error instanceof ImapError && error.reason === "login" ? "login" : "network";
    })
    .finally(() => session.logout());
  return { sourceId: source.id, folders };
}

async function presence(db: Db, teamId: string, addresses: string[]) {
  const found = new Map<string, { kind: "mailbox" | "alias"; mailboxId: string }>();
  if (!addresses.length) return found;
  for (const box of await db
    .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.teamId, teamId), inArray(schema.mailboxes.address, addresses))))
    found.set(box.address, { kind: "mailbox", mailboxId: box.id });
  for (const alias of await db
    .select({ address: schema.mailboxAliases.address, mailboxId: schema.mailboxAliases.mailboxId })
    .from(schema.mailboxAliases)
    .where(
      and(
        eq(schema.mailboxAliases.teamId, teamId),
        inArray(schema.mailboxAliases.address, addresses),
      ),
    ))
    if (!found.has(alias.address))
      found.set(alias.address, { kind: "alias", mailboxId: alias.mailboxId });
  return found;
}

export async function migrationStatus(db: Db, actor: MailboxRegistryActor, sourceId: string) {
  await withMailboxRegistryAdmin(db, actor, async () => null);
  const source = ownSource(actor, sourceId);
  // A restart or an expired source asks for the password again; another team's id looks the same.
  if (!source)
    return {
      sourceId,
      phase: "failed" as Phase,
      foldersDone: 0,
      foldersTotal: 0,
      messagesSeen: 0,
      truncated: false,
      externalByDomain: [],
      addresses: [],
      failure: "reconnect" as const,
    };
  const { result } = source;
  const list = [...result.addresses.entries()];
  const known = await presence(
    db,
    actor.teamId,
    list.map(([address]) => address),
  );
  return {
    sourceId,
    phase: source.phase,
    foldersDone: result.foldersDone,
    foldersTotal: result.foldersTotal,
    messagesSeen: result.messagesSeen,
    truncated: result.truncated,
    externalByDomain: [...result.external.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([domain, messages]) => ({ domain, messages })),
    addresses: list
      .sort((a, b) => b[1].messages - a[1].messages)
      .map(([address, entry]) => ({
        address,
        domain: address.slice(address.lastIndexOf("@") + 1),
        localPart: address.slice(0, address.lastIndexOf("@")),
        messages: entry.messages,
        lastSeenAt: entry.lastSeenAt,
        inMepMail: known.get(address)?.kind ?? null,
        mailboxId: known.get(address)?.mailboxId ?? null,
      })),
    failure: source.failure,
  };
}

export interface PlanItem {
  address: string;
  action: "mailbox" | "alias" | "ignore";
  mailboxId: string | null;
  ownerUserId: string | null;
  label: string | null;
}
export type PlanOutcome =
  | "ok"
  | "exists"
  | "ignored"
  | "conflict"
  | "over_alias_cap"
  | "needs_license"
  | "domain_missing"
  | "invalid";

/** The authority on what apply would do; it never writes. */
export async function planMigration(db: Db, actor: MailboxRegistryActor, items: PlanItem[]) {
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const addresses = [...new Set(items.map((item) => item.address.trim().toLowerCase()))];
    const domains = await teamDomains(tx, actor.teamId);
    const boxes = await tx
      .select({
        id: schema.mailboxes.id,
        domainId: schema.mailboxes.domainId,
        status: schema.mailboxes.status,
      })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.teamId, actor.teamId));
    const known = await presence(tx, actor.teamId, addresses);
    const elsewhere = new Set<string>();
    if (addresses.length) {
      for (const row of await tx
        .select({ address: schema.mailboxes.address })
        .from(schema.mailboxes)
        .where(
          and(
            ne(schema.mailboxes.teamId, actor.teamId),
            inArray(schema.mailboxes.address, addresses),
          ),
        ))
        elsewhere.add(row.address);
      for (const row of await tx
        .select({ address: schema.mailboxAliases.address })
        .from(schema.mailboxAliases)
        .where(
          and(
            ne(schema.mailboxAliases.teamId, actor.teamId),
            inArray(schema.mailboxAliases.address, addresses),
          ),
        ))
        elsewhere.add(row.address);
    }
    const aliasCounts = new Map<string, number>();
    for (const row of await tx
      .select({ mailboxId: schema.mailboxAliases.mailboxId })
      .from(schema.mailboxAliases)
      .where(eq(schema.mailboxAliases.teamId, actor.teamId)))
      aliasCounts.set(row.mailboxId, (aliasCounts.get(row.mailboxId) ?? 0) + 1);
    const service = await mailboxServiceState(tx, actor.teamId);
    let seatsLeft = service.unlimitedSeats
      ? Number.POSITIVE_INFINITY
      : Math.max(0, service.seats - service.reservedSeats);
    const seen = new Set<string>();
    let newMailboxes = 0;
    let newAliases = 0;
    let licensesNeeded = 0;
    const results = items.map((item) => {
      const address = item.address.trim().toLowerCase();
      const outcome = ((): PlanOutcome => {
        const at = address.lastIndexOf("@");
        const local = address.slice(0, at);
        const domainName = address.slice(at + 1);
        if (
          at <= 0 ||
          !LOCAL.test(local) ||
          local.includes("..") ||
          address.length > 254 ||
          seen.has(address)
        )
          return "invalid";
        seen.add(address);
        if (item.action === "ignore") return "ignored";
        if (known.has(address)) return "exists";
        if (elsewhere.has(address)) return "conflict";
        const domain = domains.find((d) => d.name.toLowerCase() === domainName);
        if (!domain) return "domain_missing";
        if (item.action === "mailbox") {
          if (!item.ownerUserId) return "invalid";
          if (seatsLeft <= 0) {
            licensesNeeded++;
            return "needs_license";
          }
          seatsLeft--;
          newMailboxes++;
          return "ok";
        }
        const target = boxes.find((box) => box.id === item.mailboxId);
        if (!target || target.domainId !== domain.id || target.status !== "planned")
          return "invalid";
        const count = aliasCounts.get(target.id) ?? 0;
        if (count >= MAX_ALIASES_PER_MAILBOX) return "over_alias_cap";
        aliasCounts.set(target.id, count + 1);
        newAliases++;
        return "ok";
      })();
      return {
        address,
        outcome,
        domainId: domains.find((d) => address.endsWith(`@${d.name.toLowerCase()}`))?.id ?? null,
      };
    });
    return { results, newMailboxes, newAliases, licensesNeeded };
  });
}

/** Applies only what plan approves, one item at a time; never changes what already exists. */
export async function applyMigration(
  db: Db,
  actor: MailboxRegistryActor,
  items: PlanItem[],
  createAllowed: (tx: Db) => Promise<boolean>,
) {
  const plan = await planMigration(db, actor, items);
  const results: {
    address: string;
    outcome: "created_mailbox" | "created_alias" | "skipped" | "failed";
    id: string | null;
    reason: string | null;
  }[] = [];
  const touched = new Set<string>();
  for (const [index, item] of items.entries()) {
    const verdict = plan.results[index]!;
    if (verdict.outcome !== "ok" || !verdict.domainId) {
      results.push({
        address: verdict.address,
        outcome: "skipped",
        id: null,
        reason: verdict.outcome,
      });
      continue;
    }
    const at = verdict.address.lastIndexOf("@");
    const localPart = verdict.address.slice(0, at);
    try {
      if (item.action === "mailbox") {
        const row = await withMailboxRegistryAdmin(db, actor, async (tx) => {
          if (!(await createAllowed(tx))) throw new MigrationError("not_found");
          return createMailboxRegistry(tx, actor, {
            domainId: verdict.domainId!,
            localPart,
            label: (item.label?.trim() || localPart).slice(0, 80),
            kind: "person",
            ownerUserId: item.ownerUserId!,
          });
        });
        results.push({
          address: verdict.address,
          outcome: "created_mailbox",
          id: row.id,
          reason: null,
        });
      } else {
        const row = await addMailboxAlias(db, actor, { mailboxId: item.mailboxId!, localPart });
        results.push({
          address: verdict.address,
          outcome: "created_alias",
          id: row.id,
          reason: null,
        });
      }
      touched.add(verdict.domainId);
    } catch (error) {
      const reason =
        error instanceof MigrationError
          ? "not_allowed"
          : error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown";
      results.push({ address: verdict.address, outcome: "failed", id: null, reason });
    }
  }
  return { results, touchedDomains: [...touched] };
}

const RECEIVING = {
  ready: "receiving",
  needs_mx: "needs_mx",
  needs_activation: "needs_activation",
  unknown: "unknown",
} as const;

/** Per domain of the discovered addresses: what still lacks a mailbox or alias, and the MX state. */
export async function migrationMxReadiness(
  db: Db,
  actor: MailboxRegistryActor,
  sourceId: string,
  deps: { resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]> } = {},
) {
  await withMailboxRegistryAdmin(db, actor, async () => null);
  const source = ownSource(actor, sourceId);
  if (!source) throw new MigrationError("not_found");
  const discovered = [...source.result.addresses.keys()];
  const known = await presence(db, actor.teamId, discovered);
  const byDomain = new Map<string, string[]>();
  for (const address of discovered) {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), address]);
  }
  const domains = await teamDomains(db, actor.teamId);
  const lookupMx = deps.resolveMx ?? resolveMx;
  const out = [];
  for (const [name, addresses] of [...byDomain.entries()].sort()) {
    const domain = domains.find((d) => d.name.toLowerCase() === name) ?? null;
    let recipients = 0;
    let receivingState = "not_in_mepmail";
    if (domain) {
      const [boxes, aliases] = await Promise.all([
        db
          .select({ id: schema.mailboxes.id })
          .from(schema.mailboxes)
          .where(
            and(eq(schema.mailboxes.domainId, domain.id), eq(schema.mailboxes.status, "planned")),
          ),
        db
          .select({ id: schema.mailboxAliases.id })
          .from(schema.mailboxAliases)
          .where(eq(schema.mailboxAliases.domainId, domain.id)),
      ]);
      recipients = boxes.length + aliases.length;
      try {
        const readiness = await getMailboxReceivingReadiness(
          db,
          actor,
          domain.id,
          mailboxReceivingDeps(),
        );
        receivingState = RECEIVING[readiness.receiving_state] ?? "unknown";
      } catch {
        receivingState = "unknown";
      }
    }
    let mx: { exchange: string; priority: number } | null = null;
    try {
      mx = (await lookupMx(name)).sort((a, b) => a.priority - b.priority)[0] ?? null;
    } catch {
      mx = null;
    }
    out.push({
      domain: name,
      domainId: domain?.id ?? null,
      pending: addresses.filter((address) => !known.has(address)).sort(),
      recipients,
      recipientCap: RECIPIENT_CAP,
      receivingState,
      mx,
    });
  }
  return { domains: out };
}
