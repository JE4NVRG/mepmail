import {
  getMailboxReceivingReadiness,
  type MailboxReceivingReason,
  type MailboxRegistryActor,
  mailboxHoldsSeat,
  mailboxServiceEntitlement,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, count, eq } from "drizzle-orm";
import { mailboxReceivingDeps } from "./mailbox-receiving";
import { mailboxCreateAccessEnabled } from "./mailboxes";

/**
 * What a Correio mailbox needs before it is usable, layer by layer, read-only:
 *
 * - registered: the address exists in the registry (state "active"; the registry's own
 *   `status` says "planned" for an active mailbox, a legacy name);
 * - receiving: core's live receiving readiness: Correio is the PRIMARY MX (the lowest
 *   preference; another provider's backup MX is reported, not blocking), SES holds the
 *   identity and an active, safe receipt rule, the address is listed in it and the
 *   team's license covers the mailbox. An MX that merely exists proves nothing;
 * - sending: the domain is verified for sending (Send) and the license is active;
 * - agent access: reported by the MCP layer for the calling credential, never here.
 *
 * Send's `capabilities.receiving` on a domain is a different layer (Send never receives
 * mail) and is not Correio's receiving state. Every result says when it was checked.
 */
export interface MailboxAction {
  code: string;
  message: string;
}

const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const BILLING = "https://mepmail.dev/settings/billing?correio=1";

/** For listings: one readable state per mailbox instead of the legacy `status`. */
export function mailboxState(box: { status: string; deleteAfter?: Date | null }) {
  return box.deleteAfter ? "being_deleted" : box.status === "planned" ? "active" : "suspended";
}

const RECEIVING_ACTIONS: Partial<
  Record<MailboxReceivingReason, (domain: string, mx: string) => string>
> = {
  mx_missing: (d, mx) => `Add an MX record for ${d}: ${mx}, preference 10.`,
  mx_conflict: (d, mx) =>
    `Make ${mx} the primary MX of ${d} (the lowest preference, alone at it). Another host receives first today.`,
  rule_inactive: () =>
    "The Correio receipt rule is inactive on the provider; MepMail support must fix it.",
  rule_unsafe: () =>
    "The Correio receipt rule is not in its safe state; MepMail support must fix it.",
  provider_unavailable: () =>
    "The receiving provider could not be checked right now (or the domain's receiving identity is not verified yet); try again in a minute.",
  provider_stale: () => "The receiving check is stale; try again.",
  ingress_disabled: () => "Correio receiving is switched off on this deployment.",
  service_inactive: () =>
    `The team's Correio license is not active: a person subscribes at ${BILLING}.`,
  resource_policy_inactive: () =>
    `The team's Correio license is not active: a person subscribes at ${BILLING}.`,
};

export async function checkMailboxReadiness(
  db: Db,
  actor: MailboxRegistryActor,
  input: { domainId: string; localPart?: string | undefined; mailboxId?: string | undefined },
  now = new Date(),
) {
  const actions: MailboxAction[] = [];
  const [member] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  const [domain] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, actor.teamId)));
  if (!member || !domain) return null;
  const admin = member.role === "owner" || member.role === "admin";
  const correio = await mailboxCreateAccessEnabled(db, actor).catch(() => false);
  const canCreate = admin && correio;
  if (!admin)
    actions.push({
      code: "requester_not_admin",
      message: "Creating mailboxes needs the team's owner or admin role.",
    });
  else if (!correio)
    actions.push({
      code: "correio_unavailable",
      message: "Correio is not available to this team.",
    });

  const sendingVerified = domain.status === "verified";
  if (!sendingVerified)
    actions.push({
      code: "verify_domain",
      message: `Verify ${domain.name} for sending first (get_domain lists its DNS records; verify_domain re-checks).`,
    });

  const entitlement = await mailboxServiceEntitlement(db, actor.teamId, false, now);
  const [used] = await db
    .select({ n: count() })
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.teamId, actor.teamId), mailboxHoldsSeat()));
  const seats = entitlement.unlimitedSeats ? null : (entitlement.plan?.seats ?? 0);
  const seatsUsed = used?.n ?? 0;
  const licensed = entitlement.active && entitlement.resourcePolicyActive && !!entitlement.plan;
  const freeSeat = licensed && (seats === null || seatsUsed < seats);

  let address: string | null = null;
  let valid = true;
  let existing: Record<string, unknown> | null = null;
  if (input.mailboxId) {
    const [box] = await db
      .select({ address: schema.mailboxes.address, domainId: schema.mailboxes.domainId })
      .from(schema.mailboxes)
      .where(
        and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, actor.teamId)),
      );
    if (!box || box.domainId !== domain.id) return null;
    address = box.address;
  } else if (input.localPart !== undefined) {
    const local = input.localPart.trim().toLowerCase();
    valid = LOCAL.test(local) && !local.includes("..");
    address = `${local}@${domain.name.toLowerCase()}`;
    if (!valid)
      actions.push({
        code: "invalid_local_part",
        message:
          "Use lowercase letters, digits, dot, dash or underscore, starting and ending with a letter or digit (at most 64).",
      });
  }
  if (address) {
    const [box] = await db
      .select({
        id: schema.mailboxes.id,
        teamId: schema.mailboxes.teamId,
        kind: schema.mailboxes.kind,
        status: schema.mailboxes.status,
        ownerUserId: schema.mailboxes.ownerUserId,
        deleteAfter: schema.mailboxes.deleteAfter,
      })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.address, address));
    const [alias] = await db
      .select({ teamId: schema.mailboxAliases.teamId, mailboxId: schema.mailboxAliases.mailboxId })
      .from(schema.mailboxAliases)
      .where(eq(schema.mailboxAliases.address, address));
    if (box && box.teamId === actor.teamId)
      existing = {
        mailbox_id: box.id,
        kind: box.kind,
        state: mailboxState(box),
        owned_by_you: box.ownerUserId === actor.userId,
      };
    else if (alias && alias.teamId === actor.teamId) existing = { alias_of: alias.mailboxId };
    // Another tenant's address is only reported as taken.
    else if (box || alias) existing = { taken: true };
    if (existing && "alias_of" in existing)
      actions.push({
        code: "address_is_alias",
        message: `${address} is an alias of another mailbox.`,
      });
    if (existing && "taken" in existing)
      actions.push({ code: "address_taken", message: `${address} is not available.` });
  }
  if (!existing || !("mailbox_id" in existing)) {
    if (!licensed)
      actions.push({
        code: "license_required",
        message: `The team has no active Correio license. A person subscribes at ${BILLING}; nothing is bought from here.`,
      });
    else if (!freeSeat)
      actions.push({
        code: "seat_required",
        message: `All ${seats} mailbox seats are in use. A person adds one at ${BILLING} (nothing is bought from here), or deletes a mailbox.`,
      });
  }

  // Receiving: the live check the dashboard runs (admins only).
  let receiving: Record<string, unknown> = { state: "unknown", reasons: ["requester_not_admin"] };
  if (admin) {
    try {
      const dto = await getMailboxReceivingReadiness(db, actor, domain.id, mailboxReceivingDeps());
      const box =
        existing && "mailbox_id" in existing
          ? dto.mailboxes.find((m) => m.id === existing!.mailbox_id)
          : undefined;
      receiving = {
        state: dto.receiving_state,
        reasons: dto.reasons,
        mx: { correio_host: dto.mx.value, status: dto.mx.status, others: dto.mx.others },
        mailbox: box ? { state: box.receiving_state, reasons: box.reasons } : null,
        verified_with: "public MX lookup + the provider's live receipt rule and identity",
        checked_at: dto.checkedAt ?? now.toISOString(),
      };
      for (const reason of dto.reasons) {
        const text = RECEIVING_ACTIONS[reason]?.(
          domain.name,
          dto.mx.value ?? "Correio's inbound host",
        );
        if (text && !actions.some((a) => a.code === reason))
          actions.push({ code: reason, message: text });
      }
      if (dto.reasons.includes("mx_backup_other"))
        receiving.note = `Correio is the primary MX; ${dto.mx.others
          .map((o) => `${o.exchange} (${o.priority})`)
          .join(
            ", ",
          )} only receive while Correio is unreachable. Leave them until a planned migration removes them.`;
      if (box?.reasons.includes("recipient_not_enabled"))
        actions.push({
          code: "list_address",
          message:
            "The address is not in the receiving rules yet: create_mailbox again reconciles it.",
        });
    } catch {
      receiving = { state: "unknown", reasons: ["check_failed"], checked_at: now.toISOString() };
      actions.push({
        code: "check_failed",
        message: "The receiving check failed; try again shortly.",
      });
    }
  }

  const registered = !!existing && "mailbox_id" in existing && existing.state === "active";
  const mailboxReceiving =
    receiving.mailbox && typeof receiving.mailbox === "object"
      ? (receiving.mailbox as { state: string }).state
      : null;
  return {
    checked_at: now.toISOString(),
    requester: { role: member.role, can_create_mailboxes: canCreate },
    domain: {
      id: domain.id,
      name: domain.name,
      region: domain.region,
      sending: domain.status,
      note: "Send's capabilities.receiving (list_domains) is Send's own: Send never receives mail. Correio receiving is `receiving` here.",
    },
    address: address ? { address, valid, available: valid && existing === null, existing } : null,
    license: {
      kind: entitlement.licenseKind,
      active: licensed,
      seats,
      seats_used: seatsUsed,
      can_add_mailbox: freeSeat,
      purchase_required: !freeSeat,
      purchase_where: freeSeat ? null : BILLING,
    },
    receiving,
    sending: {
      state: !sendingVerified ? "domain_not_verified" : !licensed ? "no_license" : "ready",
    },
    ready: {
      registered,
      receiving: registered && mailboxReceiving === "ready",
      sending: registered && sendingVerified && licensed,
    },
    actions,
  };
}
