import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

export type OperationsAccess = NonNullable<typeof schema.teamMembers.$inferSelect.operationsAccess>;
export type OperationsInvitationAccess = NonNullable<
  typeof schema.teamInvitations.$inferSelect.operationsAccess
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ids(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(value).size === value.length
  );
}

/** Malformed, stale or future policy formats never grant a capability. */
export function parseOperationsAccess(value: unknown): OperationsAccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => !["version", "userDirectoryRead", "mailboxCreateDomainIds"].includes(k),
    ) ||
    v.version !== 1 ||
    typeof v.userDirectoryRead !== "boolean" ||
    !ids(v.mailboxCreateDomainIds, 20)
  )
    return null;
  return {
    version: 1,
    userDirectoryRead: v.userDirectoryRead,
    mailboxCreateDomainIds: [...v.mailboxCreateDomainIds],
  };
}

export function parseOperationsInvitationAccess(value: unknown): OperationsInvitationAccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { sendMailboxIds, ...base } = value as Record<string, unknown>;
  const access = parseOperationsAccess(base);
  return access && ids(sendMailboxIds, 20)
    ? { ...access, sendMailboxIds: [...sendMailboxIds] }
    : null;
}

/** Re-check current membership, verified identity and team state; never trust session roles. */
export async function mailboxCreationAccess(
  db: Db,
  actor: { teamId: string; userId: string },
  lock = false,
): Promise<{ canManage: boolean; canCreate: boolean; domainIds: string[] | null }> {
  const query = db
    .select({
      role: schema.teamMembers.role,
      operationsAccess: schema.teamMembers.operationsAccess,
      verified: schema.user.emailVerified,
      suspendedAt: schema.teams.suspendedAt,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  const [member] = await (lock ? query.for("share") : query);
  if (!member || member.suspendedAt) return { canManage: false, canCreate: false, domainIds: [] };
  const canManage = member.role === "owner" || member.role === "admin";
  if (canManage) return { canManage: true, canCreate: true, domainIds: null };
  const access =
    member.role === "member" && member.verified
      ? parseOperationsAccess(member.operationsAccess)
      : null;
  const domainIds = access?.mailboxCreateDomainIds ?? [];
  if (domainIds.length) {
    const domains = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(and(eq(schema.domains.teamId, actor.teamId), inArray(schema.domains.id, domainIds)));
    if (domains.length !== domainIds.length)
      return { canManage: false, canCreate: false, domainIds: [] };
  }
  return {
    canManage: false,
    canCreate: domainIds.length > 0,
    domainIds,
  };
}

/** Only this capability admits a global directory read; no other console procedure uses it. */
export async function canReadUserDirectory(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ access: schema.teamMembers.operationsAccess })
    .from(schema.teamMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(
        eq(schema.teamMembers.userId, userId),
        eq(schema.teamMembers.role, "member"),
        eq(schema.user.emailVerified, true),
        isNull(schema.teams.suspendedAt),
        isNotNull(schema.teamMembers.operationsAccess),
      ),
    );
  return rows.some(({ access }) => parseOperationsAccess(access)?.userDirectoryRead === true);
}

/** Resolve the exact reviewed targets against live rows in their team, without opening content. */
export async function operationsInvitationTargets(
  db: Db,
  teamId: string,
  access: OperationsInvitationAccess,
) {
  const parsed = parseOperationsInvitationAccess(access);
  if (!parsed || parsed.mailboxCreateDomainIds.length === 0)
    throw new Error("invalid_operations_access");
  const [team] = await db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(and(eq(schema.teams.id, teamId), isNull(schema.teams.suspendedAt)));
  if (!team) throw new Error("invalid_operations_team");
  const domains = await db
    .select({ id: schema.domains.id, name: schema.domains.name })
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.teamId, teamId),
        inArray(schema.domains.id, parsed.mailboxCreateDomainIds),
      ),
    )
    .orderBy(schema.domains.id);
  if (domains.length !== parsed.mailboxCreateDomainIds.length)
    throw new Error("invalid_operations_domain_scope");
  const mailboxes = parsed.sendMailboxIds.length
    ? await db
        .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
        .from(schema.mailboxes)
        .where(
          and(
            eq(schema.mailboxes.teamId, teamId),
            eq(schema.mailboxes.origin, "domain"),
            eq(schema.mailboxes.status, "planned"),
            isNull(schema.mailboxes.deleteAfter),
            inArray(schema.mailboxes.domainId, parsed.mailboxCreateDomainIds),
            inArray(schema.mailboxes.id, parsed.sendMailboxIds),
          ),
        )
        .orderBy(schema.mailboxes.id)
    : [];
  if (mailboxes.length !== parsed.sendMailboxIds.length)
    throw new Error("invalid_operations_mailbox_scope");
  return { access: parsed, domains, mailboxes };
}
