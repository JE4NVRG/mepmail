import { type Db, schema } from "@millionsend/db";
import { and, asc, eq } from "drizzle-orm";
import {
  type MailboxRegistryActor,
  MailboxRegistryError,
  mailboxDomainLock,
  withMailboxRegistryAdmin,
} from "./mailbox-registry.js";
import { mailboxServiceEntitlement } from "./mailbox-service.js";

export type MailboxReceivingState = "unknown" | "needs_mx" | "needs_activation" | "ready";
export type MailboxReceivingReason =
  | "configuration_missing"
  | "dns_unavailable"
  | "mx_missing"
  | "mx_conflict"
  | "provider_unavailable"
  | "provider_stale"
  | "provider_context_mismatch"
  | "rule_inactive"
  | "rule_unsafe"
  | "ingress_disabled"
  | "recipient_not_enabled"
  | "service_inactive"
  | "resource_policy_inactive"
  | "seat_not_licensed"
  | "owner_inactive"
  | "mailbox_suspended"
  | "state_changed";

export interface MailboxReceivingDomain {
  id: string;
  teamId: string;
  name: string;
  region: string;
}
/** Only a trusted server adapter supplies configuration and live provider facts.
 * No receipt-rule, topic, bucket or credential identifier is returned in the DTO.
 */
export interface MailboxReceivingObservation {
  domainId: string;
  teamId: string;
  domainName: string;
  region: string;
  checkedAt: Date | string;
  ruleSetActive: boolean;
  ruleEnabled: boolean;
  tlsRequired: boolean;
  scanEnabled: boolean;
  storageReady: boolean;
  notificationReady: boolean;
  recipients: readonly string[];
}
export interface MailboxReceivingDeps {
  configuration(domain: Readonly<MailboxReceivingDomain>): {
    /** Explicit receiving endpoint; never inferred from MAIL FROM or send verification. */
    mxExchange: string;
    ingressEnabled: boolean;
  } | null;
  resolveMx(name: string): Promise<readonly { exchange: string; priority: number }[]>;
  observe(domain: Readonly<MailboxReceivingDomain>): Promise<MailboxReceivingObservation | null>;
  now?: () => Date;
  /** Freshness is bounded to one minute; defaults to thirty seconds. */
  maxAgeMs?: number;
}
export interface MailboxReceivingReadiness {
  domainId: string;
  domainName: string;
  region: string;
  receiving_state: MailboxReceivingState;
  checkedAt: string | null;
  mx: {
    type: "MX";
    name: string;
    value: string | null;
    priority: 10;
    status: "unknown" | "missing" | "conflict" | "ready";
  };
  reasons: MailboxReceivingReason[];
  mailboxes: {
    id: string;
    address: string;
    receiving_state: "reserved" | "ready" | "suspended";
    reasons: MailboxReceivingReason[];
  }[];
}

function host(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim()) return null;
  const normalized = value.toLowerCase().replace(/\.$/, "");
  if (
    !normalized.includes(".") ||
    !normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return normalized;
}

async function snapshot(db: Db, actor: MailboxRegistryActor, domainId: string) {
  // Preserve mutation lock order: membership, service, then domain/boxes.
  const service = await mailboxServiceEntitlement(db, actor.teamId, true);
  await mailboxDomainLock(db, domainId);
  const [domain] = await db
    .select({
      id: schema.domains.id,
      teamId: schema.domains.teamId,
      name: schema.domains.name,
      region: schema.domains.region,
    })
    .from(schema.domains)
    .where(and(eq(schema.domains.id, domainId), eq(schema.domains.teamId, actor.teamId)))
    .for("share");
  if (!domain) throw new MailboxRegistryError("not_found");
  const allocation = db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, actor.teamId))
    .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id));
  const licensed =
    service.resourcePolicyActive && service.plan
      ? await (service.unlimitedSeats ? allocation : allocation.limit(service.plan.seats))
      : [];
  const licensedIds = new Set(licensed.map((box) => box.id));
  const owners = await db
    .select({ id: schema.teamMembers.id, userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.teamId, actor.teamId))
    .for("share");
  const boxes = await db
    .select({
      id: schema.mailboxes.id,
      address: schema.mailboxes.address,
      status: schema.mailboxes.status,
      ownerUserId: schema.mailboxes.ownerUserId,
      ownerMembershipId: schema.mailboxes.ownerMembershipId,
    })
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.teamId, actor.teamId), eq(schema.mailboxes.domainId, domainId)))
    .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id))
    .for("share");
  return {
    domain,
    service: { active: service.active, resourcePolicyActive: service.resourcePolicyActive },
    boxes: boxes.map((box) => ({
      id: box.id,
      address: box.address,
      status: box.status,
      licensed: licensedIds.has(box.id),
      ownerActive: owners.some(
        (owner) => owner.id === box.ownerMembershipId && owner.userId === box.ownerUserId,
      ),
    })),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;

function configured(deps: MailboxReceivingDeps, domain: MailboxReceivingDomain) {
  try {
    const value = deps.configuration(Object.freeze({ ...domain }));
    const mxExchange = host(value?.mxExchange);
    if (!mxExchange || typeof value?.ingressEnabled !== "boolean") return null;
    return { mxExchange, ingressEnabled: value.ingressEnabled };
  } catch {
    return null;
  }
}

function assessment(
  state: Snapshot,
  config: ReturnType<typeof configured>,
  dns: PromiseSettledResult<readonly { exchange: string; priority: number }[]>,
  observation: PromiseSettledResult<MailboxReceivingObservation | null>,
  now: Date,
  maxAgeMs: number,
  changed = false,
): MailboxReceivingReadiness {
  const reasons: MailboxReceivingReason[] = [];
  let mx: MailboxReceivingReadiness["mx"]["status"] = "unknown";
  let checkedAt: string | null = null;
  let proofReady = false;
  const recipients = new Set<string>();
  if (changed) reasons.push("state_changed");
  else if (!config) reasons.push("configuration_missing");
  else {
    if (dns.status !== "fulfilled" || !Array.isArray(dns.value)) reasons.push("dns_unavailable");
    else if (!dns.value.length) {
      mx = "missing";
      reasons.push("mx_missing");
    } else if (
      dns.value.every(
        (record) =>
          record &&
          typeof record === "object" &&
          host(record.exchange) === config.mxExchange &&
          Number.isInteger(record.priority) &&
          record.priority >= 0 &&
          record.priority <= 65535,
      )
    )
      mx = "ready";
    else {
      mx = "conflict";
      reasons.push("mx_conflict");
    }
    const proof = observation.status === "fulfilled" ? observation.value : null;
    if (!proof || typeof proof !== "object") reasons.push("provider_unavailable");
    else if (
      proof.domainId !== state.domain.id ||
      proof.teamId !== state.domain.teamId ||
      host(proof.domainName) !== host(state.domain.name) ||
      proof.region !== state.domain.region
    )
      reasons.push("provider_context_mismatch");
    else {
      const time =
        typeof proof.checkedAt === "string" || proof.checkedAt instanceof Date
          ? new Date(proof.checkedAt).getTime()
          : Number.NaN;
      if (!Number.isFinite(time) || time > now.getTime() || now.getTime() - time > maxAgeMs)
        reasons.push("provider_stale");
      else {
        checkedAt = new Date(time).toISOString();
        const switches = [
          proof.ruleSetActive,
          proof.ruleEnabled,
          proof.tlsRequired,
          proof.scanEnabled,
          proof.storageReady,
          proof.notificationReady,
        ];
        if (
          !switches.every((flag) => typeof flag === "boolean") ||
          !Array.isArray(proof.recipients) ||
          !proof.recipients.length ||
          !proof.recipients.every((address) => {
            if (typeof address !== "string" || address !== address.trim() || address.length > 254)
              return false;
            const parts = address.toLowerCase().split("@");
            return (
              parts.length === 2 &&
              /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(parts[0] ?? "") &&
              !parts[0]?.includes("..") &&
              parts[1] === state.domain.name.toLowerCase()
            );
          })
        )
          reasons.push("rule_unsafe");
        else {
          for (const recipient of proof.recipients) recipients.add(recipient.toLowerCase());
          if (!proof.ruleSetActive || !proof.ruleEnabled) reasons.push("rule_inactive");
          if (
            !proof.tlsRequired ||
            !proof.scanEnabled ||
            !proof.storageReady ||
            !proof.notificationReady
          )
            reasons.push("rule_unsafe");
          proofReady = switches.every((flag) => flag === true);
        }
      }
    }
    if (!config.ingressEnabled) reasons.push("ingress_disabled");
  }
  if (!state.service.active) reasons.push("service_inactive");
  if (!state.service.resourcePolicyActive) reasons.push("resource_policy_inactive");
  const receiving_state: MailboxReceivingState =
    changed ||
    !config ||
    mx === "unknown" ||
    reasons.some((reason) =>
      ["provider_unavailable", "provider_stale", "provider_context_mismatch"].includes(reason),
    )
      ? "unknown"
      : mx !== "ready"
        ? "needs_mx"
        : !proofReady ||
            !config.ingressEnabled ||
            !state.service.active ||
            !state.service.resourcePolicyActive
          ? "needs_activation"
          : "ready";
  return {
    domainId: state.domain.id,
    domainName: state.domain.name,
    region: state.domain.region,
    receiving_state,
    checkedAt,
    mx: {
      type: "MX",
      name: state.domain.name,
      value: config?.mxExchange ?? null,
      priority: 10,
      status: mx,
    },
    reasons,
    mailboxes: state.boxes.map((box) => {
      const boxReasons = [...reasons];
      if (box.status === "suspended") boxReasons.push("mailbox_suspended");
      if (!box.ownerActive) boxReasons.push("owner_inactive");
      if (!box.licensed) boxReasons.push("seat_not_licensed");
      if (!recipients.has(box.address)) boxReasons.push("recipient_not_enabled");
      return {
        id: box.id,
        address: box.address,
        receiving_state:
          box.status === "suspended"
            ? ("suspended" as const)
            : receiving_state === "ready" &&
                box.ownerActive &&
                box.licensed &&
                recipients.has(box.address)
              ? ("ready" as const)
              : ("reserved" as const),
        reasons: boxReasons,
      };
    }),
  };
}

/** Reservation is unaffected. Readiness is a fresh, scoped observation, not a
 * promise of delivery or a write to domains.status/mailboxes.status.
 * External lookups occur outside DB locks; authority and the snapshot are
 * rechecked afterwards before any result is returned.
 */
export async function getMailboxReceivingReadiness(
  db: Db,
  actor: MailboxRegistryActor,
  domainId: string,
  deps: MailboxReceivingDeps,
): Promise<MailboxReceivingReadiness> {
  const maxAgeMs = deps.maxAgeMs ?? 30000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 60000)
    throw new MailboxRegistryError("invalid");
  const before = await withMailboxRegistryAdmin(db, actor, (tx) => snapshot(tx, actor, domainId));
  const config = configured(deps, before.domain);
  const [dns, proof] = config
    ? await Promise.allSettled([
        Promise.resolve().then(() => deps.resolveMx(before.domain.name)),
        Promise.resolve().then(() => deps.observe(Object.freeze({ ...before.domain }))),
      ])
    : ([
        { status: "rejected", reason: null },
        { status: "rejected", reason: null },
      ] as const);
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const current = await snapshot(tx, actor, domainId);
    const now = deps.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new MailboxRegistryError("invalid");
    const nextConfig = configured(deps, current.domain);
    const changed =
      JSON.stringify(before) !== JSON.stringify(current) ||
      JSON.stringify(config) !== JSON.stringify(nextConfig);
    return assessment(current, changed ? null : config, dns, proof, now, maxAgeMs, changed);
  });
}
