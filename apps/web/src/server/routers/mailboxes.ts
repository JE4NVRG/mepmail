import {
  beginMailboxCheckout,
  MailboxLifecycleError,
  manageMailboxSubscription,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import {
  createMailboxAgentKey,
  createMailboxRegistry,
  grantMailboxRegistry,
  listMailboxAgentKeys,
  listMailboxRegistry,
  MailboxAgentAccessError,
  MailboxContentError,
  MailboxRegistryError,
  MailboxServiceError,
  mailboxServiceState,
  queueMailboxDraft,
  revokeMailboxAgentKey,
  revokeMailboxRegistry,
  updateMailboxRegistry,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getKeyring } from "../keyring";
import {
  mailboxBillingCatalog,
  mailboxBillingPresentation,
  mailboxManagementEnabled,
  mailboxPurchaseDeps,
} from "../mailbox-billing";
import {
  getMailboxContent,
  getMailboxContentList,
  saveMailboxContentDraft,
} from "../mailbox-content";
import { mailboxTransportMime } from "../mailbox-transport";
import { mailboxAccessEnabled } from "../mailboxes";
import { getQueue } from "../queue";
import { router, teamProcedure } from "../trpc";

const enabled = teamProcedure.use(({ ctx, next }) => {
  if (!mailboxAccessEnabled({ teamId: ctx.teamId, userId: ctx.session.user.id }))
    throw new TRPCError({ code: "NOT_FOUND" });
  // Existing operator support grants cover outbound operations, not private mailbox content or registry.
  if (ctx.supportView) throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailboxLifecycleError)
      throw new TRPCError({
        code:
          error.code === "forbidden"
            ? "FORBIDDEN"
            : error.code === "invalid"
              ? "BAD_REQUEST"
              : "PRECONDITION_FAILED",
        message: error.code,
      });
    if (error instanceof MailboxAgentAccessError)
      throw new TRPCError({
        code:
          error.code === "quota"
            ? "PRECONDITION_FAILED"
            : error.code === "invalid"
              ? "BAD_REQUEST"
              : error.code === "not_found"
                ? "NOT_FOUND"
                : "FORBIDDEN",
      });
    if (error instanceof MailboxServiceError)
      throw new TRPCError({
        code: error.code === "invalid" ? "BAD_REQUEST" : "PRECONDITION_FAILED",
        message: error.code,
      });
    if (error instanceof MailboxRegistryError || error instanceof MailboxContentError)
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
  capabilities: teamProcedure.query(({ ctx }) => {
    const enabled = mailboxAccessEnabled(actor(ctx)) && !ctx.supportView;
    return {
      enabled,
      deliveryReady: enabled && process.env.MAILBOX_TRANSPORT_ENABLED === "1",
    };
  }),
  list: enabled.query(({ ctx }) => call(() => listMailboxRegistry(ctx.db, actor(ctx)))),
  service: enabled.query(async ({ ctx }) => {
    await call(() => listMailboxRegistry(ctx.db, actor(ctx)));
    return mailboxServiceState(ctx.db, ctx.teamId);
  }),
  billing: enabled.query(({ ctx }) => call(() => mailboxBillingPresentation(ctx.db, actor(ctx)))),
  manage: enabled
    .input(
      z
        .object({
          action: z.enum(["cancel", "resume", "quantity", "reconcile"]),
          seats: z.number().int().min(1).max(10000).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const presentation = await call(() => mailboxBillingPresentation(ctx.db, actor(ctx)));
      if (!presentation.canManage) throw new TRPCError({ code: "FORBIDDEN" });
      if (!mailboxManagementEnabled() || !presentation.management.canReconcile)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailbox_billing_unavailable",
        });
      if (input.action === "quantity" && input.seats === undefined)
        throw new TRPCError({ code: "BAD_REQUEST" });
      const catalog = mailboxBillingCatalog();
      if (!catalog)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailbox_billing_unavailable",
        });
      return call(() =>
        manageMailboxSubscription(mailboxPurchaseDeps(ctx.db), catalog, {
          ...actor(ctx),
          ...input,
        }),
      ).catch((error: unknown) => {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "pending" });
      });
    }),
  checkout: enabled
    .input(z.object({ seats: z.number().int().min(1).max(10000) }))
    .mutation(async ({ ctx, input }) => {
      const presentation = await call(() => mailboxBillingPresentation(ctx.db, actor(ctx)));
      if (presentation.availability === "forbidden") throw new TRPCError({ code: "FORBIDDEN" });
      if (!presentation.canPurchase)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            presentation.availability === "existing_subscription"
              ? "subscription_exists"
              : presentation.availability === "recovery_required"
                ? "conflict"
                : "mailbox_billing_unavailable",
        });
      if (
        presentation.pendingCheckoutSeats !== null &&
        presentation.pendingCheckoutSeats !== input.seats
      )
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "conflict" });
      const catalog = mailboxBillingCatalog();
      if (!catalog)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailbox_billing_unavailable",
        });
      const billingUrl = `${resolveBaseUrl(env.APP_BASE_URL)}/mailboxes`;
      const checkout = await call(() =>
        beginMailboxCheckout(mailboxPurchaseDeps(ctx.db), catalog, {
          teamId: ctx.teamId,
          userId: ctx.session.user.id,
          seats: input.seats,
          successUrl: `${billingUrl}?checkout=success`,
          cancelUrl: billingUrl,
        }),
      ).catch((error: unknown) => {
        if (error instanceof TRPCError) throw error;
        // Provider/network errors may follow a committed purchase intent; expose no payload and preserve the lease.
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "pending" });
      });
      let url: URL;
      try {
        url = new URL(checkout.url);
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "pending" });
      }
      if (
        url.protocol !== "https:" ||
        url.hostname !== "checkout.stripe.com" ||
        url.username ||
        url.password ||
        url.port
      )
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "pending" });
      return { url: url.href };
    }),
  agentKeys: enabled
    .input(z.object({ mailboxId: z.uuid() }))
    .query(({ ctx, input }) =>
      call(() => listMailboxAgentKeys(ctx.db, actor(ctx), input.mailboxId)),
    ),
  createAgentKey: enabled
    .input(
      z.object({
        mailboxId: z.uuid(),
        label: z.string().min(1).max(80),
        scopes: z
          .array(z.enum(["read", "draft", "send"]))
          .min(1)
          .max(3)
          .optional(),
        expiresAt: z.date().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const key = await call(() => createMailboxAgentKey(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.agent_key_created",
        target: { type: "mailbox_agent_key", id: key.id },
      });
      return key;
    }),
  revokeAgentKey: enabled
    .input(z.object({ mailboxId: z.uuid(), id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const key = await call(() => revokeMailboxAgentKey(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.agent_key_revoked",
        target: { type: "mailbox_agent_key", id: key.id },
      });
      return key;
    }),
  queueDraft: enabled
    .input(
      z.object({
        mailboxId: z.uuid(),
        id: z.uuid(),
        expectedRevision: z.number().int().min(1).max(2147483646),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.MAILBOX_TRANSPORT_ENABLED !== "1")
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "mailbox_transport_unavailable",
        });
      const result = await call(() =>
        queueMailboxDraft(ctx.db, getKeyring(), actor(ctx), input, mailboxTransportMime),
      );
      // Commit-first outbox plus reconcile repairs a failed enqueue without another send.
      await (await getQueue()).send(
        "mailbox.send",
        { outboxId: result.id },
        { dedupeKey: result.id },
      );
      await recordAudit(ctx, {
        action: "mailbox.send_queued",
        target: { type: "mailbox_outbox", id: result.id },
      });
      return result;
    }),
  items: enabled
    .input(
      z.object({ mailboxId: z.uuid().nullable(), folder: z.enum(["inbox", "drafts", "sent"]) }),
    )
    .query(({ ctx, input }) => call(() => getMailboxContentList(ctx.db, actor(ctx), input))),
  item: enabled
    .input(z.object({ mailboxId: z.uuid(), id: z.uuid() }))
    .query(({ ctx, input }) => call(() => getMailboxContent(ctx.db, actor(ctx), input))),
  saveDraft: enabled
    .input(
      z.object({
        mailboxId: z.uuid(),
        id: z.uuid().optional(),
        expectedRevision: z.number().int().min(0).max(2147483646),
        sourceItemId: z.uuid().optional(),
        mode: z.enum(["reply", "forward"]).optional(),
        to: z.array(z.email().max(254)).max(20),
        subject: z
          .string()
          .max(998)
          .regex(/^[^\r\n]*$/),
        text: z.string().max(262144),
        retainedAttachments: z.array(z.number().int().min(0).max(9)).max(10),
        uploads: z
          .array(
            z.object({
              filename: z.string().min(1).max(160),
              base64: z.string().min(1).max(349528),
            }),
          )
          .max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await call(() => saveMailboxContentDraft(ctx.db, actor(ctx), input));
      await recordAudit(ctx, {
        action: "mailbox.draft_saved",
        target: { type: "mailbox_item", id: result.id },
      });
      return result;
    }),
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
