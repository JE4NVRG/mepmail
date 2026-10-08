import { type Db, schema } from "@millionsend/db";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { lockMailboxAgentKeysForOwnerChange } from "./mailbox-agent-access.js";
import { mailboxServiceEntitlement, reserveMailboxSeat } from "./mailbox-service.js";

export class MailboxRegistryError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "invalid" | "conflict") {
    super(code);
  }
}
export interface MailboxRegistryActor {
  teamId: string;
  userId: string;
}

function invalidControl(value: string, multiline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && !(multiline && [9, 10, 13].includes(code))) || code === 127;
  });
}

function signatureText(value: string | undefined) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 4000 || invalidControl(value, true))
    throw new MailboxRegistryError("invalid");
  return value.replace(/\r\n?/g, "\n");
}

async function member(db: Db, actor: MailboxRegistryActor, lock = false) {
  if (lock)
    await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, actor.teamId))
      .for("share");
  const query = db
    .select({ id: schema.teamMembers.id, role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  const [row] = await (lock ? query.for("share") : query);
  if (!row) throw new MailboxRegistryError("forbidden");
  return row;
}
async function admin(db: Db, actor: MailboxRegistryActor) {
  const { role } = await member(db, actor, true);
  if (role !== "owner" && role !== "admin") throw new MailboxRegistryError("forbidden");
}
/** Keep the actor's current administrative role stable until the scoped read completes. */
export async function withMailboxRegistryAdmin<T>(
  db: Db,
  actor: MailboxRegistryActor,
  read: (transaction: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await admin(transaction, actor);
    return read(transaction);
  });
}
async function box(db: Db, actor: MailboxRegistryActor, id: string) {
  const [row] = await db
    .select()
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.id, id), eq(schema.mailboxes.teamId, actor.teamId)))
    .for("update");
  if (!row) throw new MailboxRegistryError("not_found");
  return row;
}
async function requireMember(db: Db, teamId: string, userId: string) {
  const [row] = await db
    .select({ id: schema.teamMembers.id })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)))
    .for("share");
  if (!row) throw new MailboxRegistryError("invalid");
  return row.id;
}
export async function mailboxDomainLock(db: Db, domainId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${"mailbox-domain:" + domainId}))`);
}

export async function listMailboxRegistry(db: Db, actor: MailboxRegistryActor) {
  await member(db, actor);
  const service = await mailboxServiceEntitlement(db, actor.teamId);
  const allocation = db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.teamId, actor.teamId))
    .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id));
  const licensed =
    service.resourcePolicyActive && service.plan
      ? await (service.unlimitedSeats ? allocation : allocation.limit(service.plan.seats))
      : [];
  const licensedIds = new Set(licensed.map((b) => b.id));
  const rows = await db
    .select({
      id: schema.mailboxes.id,
      domainId: schema.mailboxes.domainId,
      address: schema.mailboxes.address,
      label: schema.mailboxes.label,
      signatureText: schema.mailboxes.signatureText,
      signatureProfile: schema.mailboxes.signatureProfile,
      kind: schema.mailboxes.kind,
      ownerUserId: schema.mailboxes.ownerUserId,
      ownerMembershipId: schema.mailboxes.ownerMembershipId,
      memberId: schema.teamMembers.id,
      status: schema.mailboxes.status,
      createdAt: schema.mailboxes.createdAt,
      role: schema.teamMembers.role,
      permission: schema.mailboxGrants.permission,
    })
    .from(schema.mailboxes)
    .innerJoin(
      schema.teamMembers,
      and(
        eq(schema.teamMembers.teamId, schema.mailboxes.teamId),
        eq(schema.teamMembers.userId, actor.userId),
      ),
    )
    .leftJoin(
      schema.mailboxGrants,
      and(
        eq(schema.mailboxGrants.mailboxId, schema.mailboxes.id),
        eq(schema.mailboxGrants.teamId, schema.mailboxes.teamId),
        eq(schema.mailboxGrants.userId, actor.userId),
        eq(schema.mailboxGrants.membershipId, schema.teamMembers.id),
        isNull(schema.mailboxGrants.revokedAt),
      ),
    )
    .where(
      and(
        eq(schema.mailboxes.teamId, actor.teamId),
        or(
          inArray(schema.teamMembers.role, ["owner", "admin"]),
          and(
            eq(schema.mailboxes.ownerUserId, actor.userId),
            eq(schema.mailboxes.ownerMembershipId, schema.teamMembers.id),
          ),
          isNotNull(schema.mailboxGrants.id),
        ),
      ),
    )
    .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id));
  // Role and active grant are resolved together in the final read, not from a stale session role.
  const currentRole = rows[0]?.role ?? (await member(db, actor)).role;
  return {
    canManage: currentRole === "owner" || currentRole === "admin",
    mailboxes: rows.map(({ role: _, permission, ownerMembershipId, memberId, ...row }) => {
      const owned = row.ownerUserId === actor.userId && ownerMembershipId === memberId;
      return {
        ...row,
        ownerActive: !!ownerMembershipId,
        canRead: row.status === "planned" && (owned || !!permission),
        canDraft:
          row.status === "planned" && licensedIds.has(row.id) && (owned || permission === "draft"),
        canSend: row.status === "planned" && licensedIds.has(row.id) && owned,
        deliveryReady: false as const,
      };
    }),
  };
}

export async function createMailboxRegistry(
  db: Db,
  actor: MailboxRegistryActor,
  input: {
    domainId: string;
    localPart: string;
    label: string;
    kind: "person" | "agent";
    ownerUserId: string;
    signatureText?: string | undefined;
  },
) {
  const local = input.localPart.trim().toLowerCase();
  const label = input.label.trim();
  const signature = signatureText(input.signatureText) ?? "";
  // Deliberately excludes SMTPUTF8, quoted local parts, aliases and catch-all until their contracts exist.
  if (
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local) ||
    local.includes("..") ||
    !label ||
    label.length > 80 ||
    invalidControl(label) ||
    !["person", "agent"].includes(input.kind)
  ) {
    throw new MailboxRegistryError("invalid");
  }
  return db.transaction(async (tx) => {
    await admin(tx as unknown as Db, actor);
    await reserveMailboxSeat(tx as unknown as Db, actor.teamId);
    await mailboxDomainLock(tx as unknown as Db, input.domainId);
    const [domain] = await tx
      .select({ name: schema.domains.name })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, actor.teamId)));
    if (!domain) throw new MailboxRegistryError("not_found");
    const ownerMembershipId = await requireMember(
      tx as unknown as Db,
      actor.teamId,
      input.ownerUserId,
    );
    const address = local + "@" + domain.name.toLowerCase();
    if (address.length > 254) throw new MailboxRegistryError("invalid");
    const [row] = await tx
      .insert(schema.mailboxes)
      .values({
        teamId: actor.teamId,
        domainId: input.domainId,
        address,
        label,
        signatureText: signature,
        kind: input.kind,
        ownerUserId: input.ownerUserId,
        ownerMembershipId,
      })
      .onConflictDoNothing()
      .returning();
    // Do not disclose the team holding a globally reserved address.
    if (!row) throw new MailboxRegistryError("conflict");
    return row;
  });
}

export async function updateMailboxRegistry(
  db: Db,
  actor: MailboxRegistryActor,
  input: {
    id: string;
    label: string;
    ownerUserId: string;
    status: "planned" | "suspended";
    signatureText?: string | undefined;
  },
) {
  const label = input.label.trim();
  const signature = signatureText(input.signatureText);
  if (
    !label ||
    label.length > 80 ||
    invalidControl(label) ||
    !["planned", "suspended"].includes(input.status)
  )
    throw new MailboxRegistryError("invalid");
  return db.transaction(async (tx) => {
    await admin(tx as unknown as Db, actor);
    const ownerMembershipId = await requireMember(
      tx as unknown as Db,
      actor.teamId,
      input.ownerUserId,
    );
    const invalidate = await lockMailboxAgentKeysForOwnerChange(
      tx as unknown as Db,
      actor.teamId,
      input.id,
    );
    await box(tx as unknown as Db, actor, input.id);
    await invalidate(input.ownerUserId, ownerMembershipId);
    const [row] = await tx
      .update(schema.mailboxes)
      .set({
        label,
        ...(signature !== undefined ? { signatureText: signature } : {}),
        ownerUserId: input.ownerUserId,
        ownerMembershipId,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.mailboxes.id, input.id), eq(schema.mailboxes.teamId, actor.teamId)))
      .returning();
    if (!row) throw new MailboxRegistryError("not_found");
    return row;
  });
}

function signatureField(value: unknown, max: number) {
  if (typeof value !== "string" || invalidControl(value)) throw new MailboxRegistryError("invalid");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > max) throw new MailboxRegistryError("invalid");
  return normalized;
}

/** A website as an http(s) URL without credentials ("example.com" gains https://), or "". */
function signatureWebsite(value: string) {
  if (!value) return "";
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    throw new MailboxRegistryError("invalid");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname.includes(".")
  )
    throw new MailboxRegistryError("invalid");
  const normalized = url.toString();
  if (normalized.length > 200) throw new MailboxRegistryError("invalid");
  return normalized;
}

/** Owner of the mailbox or a team admin; locks the mailbox row for the change. */
async function signatureEditor(db: Db, actor: MailboxRegistryActor, mailboxId: string) {
  const { id: memberId, role } = await member(db, actor, true);
  const row = await box(db, actor, mailboxId);
  const owned = row.ownerUserId === actor.userId && row.ownerMembershipId === memberId;
  if (!owned && role !== "owner" && role !== "admin") throw new MailboxRegistryError("forbidden");
  return row;
}

const EMPTY_SIGNATURE: schema.MailboxSignatureProfile = {
  version: 1,
  name: "",
  title: "",
  company: "",
  phone: "",
  website: "",
  logoUrl: null,
  logoWidth: null,
  logoHeight: null,
};

/**
 * The mailbox owner or a team admin sets the structured signature (name,
 * title, company, phone, website) and its free-text lines. The logo is kept:
 * only the upload route sets it.
 */
export async function updateMailboxSignature(
  db: Db,
  actor: MailboxRegistryActor,
  input: {
    mailboxId: string;
    name: string;
    title: string;
    company: string;
    phone: string;
    website: string;
    text: string;
  },
) {
  const phone = signatureField(input.phone, 40);
  if (phone && !/^[0-9+()\-. ]+$/.test(phone)) throw new MailboxRegistryError("invalid");
  const profile = {
    name: signatureField(input.name, 80),
    title: signatureField(input.title, 80),
    company: signatureField(input.company, 80),
    phone,
    website: signatureWebsite(signatureField(input.website, 200)),
  };
  const text = signatureText(input.text) ?? "";
  return db.transaction(async (tx) => {
    const row = await signatureEditor(tx as unknown as Db, actor, input.mailboxId);
    const [updated] = await tx
      .update(schema.mailboxes)
      .set({
        signatureProfile: {
          ...EMPTY_SIGNATURE,
          ...profile,
          logoUrl: row.signatureProfile?.logoUrl ?? null,
          logoWidth: row.signatureProfile?.logoWidth ?? null,
          logoHeight: row.signatureProfile?.logoHeight ?? null,
        },
        signatureText: text,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.mailboxes.id, row.id), eq(schema.mailboxes.teamId, actor.teamId)))
      .returning();
    if (!updated) throw new MailboxRegistryError("not_found");
    return {
      id: updated.id,
      signatureText: updated.signatureText,
      signatureProfile: updated.signatureProfile,
    };
  });
}

/** The logo route checks who may edit before it writes to storage. */
export async function assertMailboxSignatureEditor(
  db: Db,
  actor: MailboxRegistryActor,
  mailboxId: string,
) {
  await db.transaction(async (tx) => {
    await signatureEditor(tx as unknown as Db, actor, mailboxId);
  });
}

/** Sets or clears the signature logo; returns the previous URL for storage cleanup. */
export async function setMailboxSignatureLogo(
  db: Db,
  actor: MailboxRegistryActor,
  input: {
    mailboxId: string;
    logoUrl: string | null;
    width?: number | null | undefined;
    height?: number | null | undefined;
  },
) {
  const dimension = (value: number | null | undefined) => {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || value < 1 || value > 4096)
      throw new MailboxRegistryError("invalid");
    return value;
  };
  const logoWidth = input.logoUrl === null ? null : dimension(input.width);
  const logoHeight = input.logoUrl === null ? null : dimension(input.height);
  if (input.logoUrl !== null) {
    let url: URL;
    try {
      url = new URL(input.logoUrl);
    } catch {
      throw new MailboxRegistryError("invalid");
    }
    if (!["https:", "http:"].includes(url.protocol) || input.logoUrl.length > 500)
      throw new MailboxRegistryError("invalid");
  }
  return db.transaction(async (tx) => {
    const row = await signatureEditor(tx as unknown as Db, actor, input.mailboxId);
    const previous = row.signatureProfile?.logoUrl ?? null;
    const [updated] = await tx
      .update(schema.mailboxes)
      .set({
        signatureProfile: {
          ...EMPTY_SIGNATURE,
          ...row.signatureProfile,
          logoUrl: input.logoUrl,
          logoWidth,
          logoHeight,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(schema.mailboxes.id, row.id), eq(schema.mailboxes.teamId, actor.teamId)))
      .returning();
    if (!updated) throw new MailboxRegistryError("not_found");
    return { previous, signatureProfile: updated.signatureProfile };
  });
}

export async function grantMailboxRegistry(
  db: Db,
  actor: MailboxRegistryActor,
  input: {
    mailboxId: string;
    userId: string;
    permission: "read" | "draft";
  },
) {
  if (!["read", "draft"].includes(input.permission)) throw new MailboxRegistryError("invalid");
  return db.transaction(async (tx) => {
    await admin(tx as unknown as Db, actor);
    const membershipId = await requireMember(tx as unknown as Db, actor.teamId, input.userId);
    await box(tx as unknown as Db, actor, input.mailboxId);
    await tx
      .update(schema.mailboxGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.mailboxGrants.teamId, actor.teamId),
          eq(schema.mailboxGrants.mailboxId, input.mailboxId),
          eq(schema.mailboxGrants.userId, input.userId),
          isNull(schema.mailboxGrants.revokedAt),
        ),
      );
    const [row] = await tx
      .insert(schema.mailboxGrants)
      .values({ ...input, membershipId, teamId: actor.teamId, grantedBy: actor.userId })
      .returning();
    return row!;
  });
}
export async function revokeMailboxRegistry(db: Db, actor: MailboxRegistryActor, id: string) {
  return db.transaction(async (tx) => {
    await admin(tx as unknown as Db, actor);
    const [row] = await tx
      .update(schema.mailboxGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.mailboxGrants.teamId, actor.teamId),
          eq(schema.mailboxGrants.id, id),
          isNull(schema.mailboxGrants.revokedAt),
        ),
      )
      .returning({ id: schema.mailboxGrants.id });
    if (!row) throw new MailboxRegistryError("not_found");
    return row;
  });
}
