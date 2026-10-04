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
  },
) {
  const local = input.localPart.trim().toLowerCase();
  const label = input.label.trim();
  // Deliberately excludes SMTPUTF8, quoted local parts, aliases and catch-all until their contracts exist.
  if (
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local) ||
    local.includes("..") ||
    !label ||
    label.length > 80 ||
    /[\r\n\x00-\x1f]/.test(label) ||
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
  },
) {
  const label = input.label.trim();
  if (
    !label ||
    label.length > 80 ||
    /[\r\n\x00-\x1f]/.test(label) ||
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
