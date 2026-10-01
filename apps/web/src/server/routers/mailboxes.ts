import {
  createMailboxRegistry,
  grantMailboxRegistry,
  listMailboxRegistry,
  MailboxRegistryError,
  revokeMailboxRegistry,
  updateMailboxRegistry,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { mailboxRegistryEnabled } from "../mailboxes";
import { router, teamProcedure } from "../trpc";

const enabled = teamProcedure.use(({ ctx, next }) => {
  if (!mailboxRegistryEnabled()) throw new TRPCError({ code: "NOT_FOUND" });
  // Existing operator support grants cover outbound operations, not private mailbox content or registry.
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailboxRegistryError)
      throw new TRPCError({
        code: {
          forbidden: "FORBIDDEN",
          not_found: "NOT_FOUND",
          invalid: "BAD_REQUEST",
          conflict: "CONFLICT",
        }[error.code] as "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
      });
    throw error;
  }
}
const actor = (ctx: { teamId: string; session: { user: { id: string } } }) => ({
  teamId: ctx.teamId,
  userId: ctx.session.user.id,
});
const boxInput = z.object({
  domainId: z.uuid(),
  localPart: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  kind: z.enum(["person", "agent"]),
  ownerUserId: z.string().min(1).max(128),
});

export const mailboxesRouter = router({
  capabilities: teamProcedure.query(({ ctx }) => ({
    enabled: mailboxRegistryEnabled() && !ctx.supportView,
    deliveryReady: false as const,
  })),
  list: enabled.query(({ ctx }) => call(() => listMailboxRegistry(ctx.db, actor(ctx)))),
  options: enabled.query(({ ctx }) =>
    call(() =>
      withMailboxRegistryAdmin(ctx.db, actor(ctx), async (db) => {
        const [domains, members] = await Promise.all([
          db
            .select({
              id: schema.domains.id,
              name: schema.domains.name,
              status: schema.domains.status,
            })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, ctx.teamId))
            .orderBy(asc(schema.domains.name)),
          db
            .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
            .from(schema.teamMembers)
            .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
            .where(eq(schema.teamMembers.teamId, ctx.teamId))
            .orderBy(asc(schema.user.name)),
        ]);
        return { domains, members, currentUserId: ctx.session.user.id };
      }),
    ),
  ),
  grants: enabled.input(z.object({ mailboxId: z.uuid() })).query(({ ctx, input }) =>
    call(() =>
      withMailboxRegistryAdmin(ctx.db, actor(ctx), async (db) => {
        const state = await listMailboxRegistry(db, actor(ctx));
        if (!state.mailboxes.some((b) => b.id === input.mailboxId))
          throw new TRPCError({ code: "NOT_FOUND" });
        return db
          .select({
            id: schema.mailboxGrants.id,
            userId: schema.mailboxGrants.userId,
            permission: schema.mailboxGrants.permission,
            name: schema.user.name,
            email: schema.user.email,
          })
          .from(schema.mailboxGrants)
          .innerJoin(schema.user, eq(schema.user.id, schema.mailboxGrants.userId))
          .innerJoin(
            schema.teamMembers,
            and(
              eq(schema.teamMembers.teamId, schema.mailboxGrants.teamId),
              eq(schema.teamMembers.userId, schema.mailboxGrants.userId),
              eq(schema.teamMembers.id, schema.mailboxGrants.membershipId),
            ),
          )
          .where(
            and(
              eq(schema.mailboxGrants.teamId, ctx.teamId),
              eq(schema.mailboxGrants.mailboxId, input.mailboxId),
              isNull(schema.mailboxGrants.revokedAt),
            ),
          );
      }),
    ),
  ),
  create: enabled.input(boxInput).mutation(async ({ ctx, input }) => {
    const row = await call(() => createMailboxRegistry(ctx.db, actor(ctx), input));
    await recordAudit(ctx, {
      action: "mailbox.created",
      target: { type: "mailbox", id: row.id },
      metadata: { kind: row.kind, domainId: row.domainId },
    });
    return { id: row.id };
  }),
  update: enabled
    .input(
      z.object({
        id: z.uuid(),
        label: z.string().min(1).max(80),
        ownerUserId: z.string().min(1).max(128),
        status: z.enum(["planned", "suspended"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await call(() => updateMailboxRegistry(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.updated",
        target: { type: "mailbox", id: row.id },
        metadata: { status: row.status, ownerUserId: row.ownerUserId },
      });
      return { id: row.id };
    }),
  grant: enabled
    .input(
      z.object({
        mailboxId: z.uuid(),
        userId: z.string().min(1).max(128),
        permission: z.enum(["read", "draft"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await call(() => grantMailboxRegistry(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.granted",
        target: { type: "mailbox", id: input.mailboxId },
        metadata: { userId: input.userId, permission: input.permission },
      });
      return { id: row.id };
    }),
  revoke: enabled.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const row = await call(() => revokeMailboxRegistry(ctx.db, actor(ctx), input.id));
    await recordAudit(ctx, {
      action: "mailbox.revoked",
      target: { type: "mailbox_grant", id: row.id },
    });
    return row;
  }),
});
