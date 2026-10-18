import {
  cancelTeamSubscription,
  isLiveKey,
  MailboxErasureError,
  type MailboxErasureStripe,
  withMailboxTeamErasure,
} from "@millionsend/billing";
import { env, isCloudDeployment } from "@millionsend/config";
import {
  DAY_MS,
  isMailPreferenceKey,
  MAIL_PREFERENCE_KEYS,
  type MailPreferenceKey,
  QUOTA_COLUMNS,
  readPeriodUsage,
  teamQuota,
  utcDay,
  verifyInviteToken,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import {
  createSesv2Client,
  deleteDomainIdentity,
  deleteTenant,
  disassociateIdentity,
  SES_REGIONS,
} from "@millionsend/ses";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, gte, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { isHexColor } from "@/lib/hex-color";
import { isHttpUrl } from "@/lib/http-url";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getStripe } from "../billing";
import { mailboxRegistryEnabled } from "../mailboxes";
import { activateOperationsInvitation } from "../operations-invitations";
import { poweredByLocked } from "../powered-by";
import { smtpRelayOffered } from "../smtp";
import { deletePublicObject, keyFromPublicUrl, uploadsEnabled } from "../storage";
import { defaultSystemMailDeps, type SystemMailDeps } from "../system-mail";
import {
  createInvitation,
  inviteEmailSchema,
  inviteRoleSchema,
  inviteSecret,
  listPendingInvitations,
  resendInvitation,
  revokeInvitation,
} from "../team-invitations";
import { protectedProcedure, publicProcedure, router, teamProcedure } from "../trpc";

/** Managing members is an owner/admin concern; plain members are read-only. */
function assertCanManageMembers(role: string): void {
  if (role !== "owner" && role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
}

/**
 * External side effects of deleting a team, injectable so tests can observe
 * them without AWS/Stripe. The Stripe cancel runs before the rows go (it
 * reads the team's subscription id); SES and storage cleanup are best-effort
 * after commit.
 */
export interface TeamDeletionDeps {
  cancelSubscription(db: Db, teamId: string): Promise<void>;
  /** Optional seams are reached only by the explicitly enabled Correio deletion flow. */
  mailboxStripe?: (() => MailboxErasureStripe) | undefined;
  mailboxLivemode?: (() => boolean) | undefined;
  /** `tenant` set = the identity is associated with the team's SES tenant and must be detached first. */
  deleteSesIdentity(domain: {
    name: string;
    region: string;
    tenant?: string | undefined;
  }): Promise<void>;
  /** Drops the team's SES tenant in one region; a tenant already gone is fine. */
  deleteSesTenant(params: { tenantName: string; region: string }): Promise<void>;
  deleteLogo(logoUrl: string): Promise<void>;
}

// Identities live in the domain's region, which may differ from AWS_REGION.
const sesClientFor = (region: string) =>
  createSesv2Client({
    region,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {}),
  });

const defaultTeamDeletionDeps: TeamDeletionDeps = {
  cancelSubscription: (db, teamId) => cancelTeamSubscription({ stripe: getStripe(), db }, teamId),
  mailboxStripe: () => getStripe() as unknown as MailboxErasureStripe,
  mailboxLivemode: () => isLiveKey(env.STRIPE_SECRET_KEY ?? ""),
  deleteSesIdentity: async ({ name, region, tenant }) => {
    const client = sesClientFor(region);
    if (tenant) await disassociateIdentity(client, { tenantName: tenant, region, identity: name });
    await deleteDomainIdentity(client, { domain: name });
  },
  deleteSesTenant: ({ tenantName, region }) => deleteTenant(sesClientFor(region), { tenantName }),
  deleteLogo: async (logoUrl) => {
    const key = keyFromPublicUrl(logoUrl);
    if (key) await deletePublicObject(key);
  },
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Drops the OAuth grants (and the tokens behind them) bound to a team — for
 * one user when given, else for everyone. All-teams grants are left alone:
 * the auth layer re-checks membership on every token refresh.
 */
async function revokeTeamGrants(tx: Tx, teamId: string, userId?: string): Promise<void> {
  const scope = (
    table:
      | typeof schema.oauthAccessToken
      | typeof schema.oauthRefreshToken
      | typeof schema.oauthConsent,
  ) => and(eq(table.referenceId, teamId), userId ? eq(table.userId, userId) : undefined);
  await tx.delete(schema.oauthAccessToken).where(scope(schema.oauthAccessToken));
  await tx.delete(schema.oauthRefreshToken).where(scope(schema.oauthRefreshToken));
  await tx.delete(schema.oauthConsent).where(scope(schema.oauthConsent));
}

async function findMembership(db: Db | Tx, teamId: string, userId: string) {
  const [row] = await db
    .select({
      id: schema.teamMembers.id,
      role: schema.teamMembers.role,
      operationsAccess: schema.teamMembers.operationsAccess,
    })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
  return row ?? null;
}

/** A team must always keep an owner, or nobody could manage or delete it. */
async function assertAnotherOwner(db: Db | Tx, teamId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, teamId),
        eq(schema.teamMembers.role, "owner"),
        ne(schema.teamMembers.userId, userId),
      ),
    );
  if (!row || row.n === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The team needs an owner." });
  }
}

async function removeMembership(db: Db, teamId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
    await revokeTeamGrants(tx, teamId, userId);
  });
}

/** `h***@example.com`: enough for the invitee to recognise, useless to anyone else. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at <= 0 ? "***" : `${email[0]}***${email.slice(at)}`;
}

/**
 * Hostname a self-hoster points their app's SMTP client at: an explicit
 * override, else the deployment's own APP_BASE_URL host (the relay runs
 * inside the same deployment), else localhost for the quickstart.
 */
function smtpPublicHost(): string {
  if (env.SMTP_PUBLIC_HOST) return env.SMTP_PUBLIC_HOST;
  return new URL(resolveBaseUrl(env.APP_BASE_URL)).hostname;
}

/** Literal shown in the SMTP tab's password field — never a real secret. */
const SMTP_PASSWORD_PLACEHOLDER = "YOUR_API_KEY";

// Trimmed empty strings clear the field. Kept nullable so the client can send
// null explicitly and the get/update round-trip is symmetric.
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable();

// http(s) only: the value becomes a Location header after unsubscribe, so a
// javascript:/data: URL must never be storable.
const nullableHttpUrl = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || isHttpUrl(v), { message: "must be an http(s) URL" });

// Strict 6-digit hex only: these values land in inline styles on the public
// unsubscribe page, so this validation is a security boundary (a db CHECK
// enforces the same shape as defense in depth).
const nullableHexColor = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .refine((v) => v === null || isHexColor(v), { message: "must be a #rrggbb hex color" });

export function createSettingsRouter(
  deps: TeamDeletionDeps = defaultTeamDeletionDeps,
  mail: SystemMailDeps = defaultSystemMailDeps,
) {
  return router({
    team: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const [team] = await ctx.db
          .select({
            name: schema.teams.name,
            slug: schema.teams.slug,
            plan: schema.teams.plan,
            logoUrl: schema.teams.logoUrl,
          })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });
        const logoUploadsEnabled = uploadsEnabled();
        return {
          ...team,
          // Storage off ⇒ stored URLs may be dead; the UI falls back to the tile.
          logoUrl: logoUploadsEnabled ? team.logoUrl : null,
          logoUploadsEnabled,
        };
      }),

      rename: teamProcedure
        .input(z.object({ name: z.string().trim().min(1).max(80) }))
        .mutation(async ({ ctx, input }) => {
          if (ctx.role === "member") throw new TRPCError({ code: "FORBIDDEN" });
          await ctx.db
            .update(schema.teams)
            .set({ name: input.name })
            .where(eq(schema.teams.id, ctx.teamId));
          return { name: input.name };
        }),

      /**
       * Owner-only, irreversible. Every team-scoped table cascades from the
       * team row; broadcasts and API keys are removed first because their
       * RESTRICT links to segments/topics/domains would otherwise block the
       * cascade. External cleanup (SES identities, logo object) runs after
       * commit and never fails the deletion — an orphaned identity is harmless.
       */
      delete: teamProcedure.mutation(async ({ ctx }) => {
        const deleteRows = async (tx: Tx) => {
          const [team] = await tx
            .select({ logoUrl: schema.teams.logoUrl, name: schema.teams.name })
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          const domains = await tx
            .select({
              name: schema.domains.name,
              region: schema.domains.region,
              sesTenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
            })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, ctx.teamId));
          await revokeTeamGrants(tx, ctx.teamId);
          await tx.delete(schema.broadcasts).where(eq(schema.broadcasts.teamId, ctx.teamId));
          await tx.delete(schema.apiKeys).where(eq(schema.apiKeys.teamId, ctx.teamId));
          await tx.delete(schema.teams).where(eq(schema.teams.id, ctx.teamId));
          return { domains, logoUrl: team.logoUrl, name: team.name };
        };
        let deleted: Awaited<ReturnType<typeof deleteRows>>;
        if (mailboxRegistryEnabled()) {
          try {
            deleted = await withMailboxTeamErasure(
              {
                db: ctx.db,
                ...(isCloudDeployment()
                  ? {
                      getStripe: deps.mailboxStripe,
                      livemode: deps.mailboxLivemode?.(),
                    }
                  : {}),
              },
              { teamId: ctx.teamId, userId: ctx.session.user.id },
              {
                ...(isCloudDeployment()
                  ? { cancelSend: (tx: Db, teamId: string) => deps.cancelSubscription(tx, teamId) }
                  : {}),
                delete: (tx) => deleteRows(tx as unknown as Tx),
              },
            );
          } catch (error) {
            if (!(error instanceof MailboxErasureError)) throw error;
            throw new TRPCError({
              code:
                error.code === "forbidden"
                  ? "FORBIDDEN"
                  : error.code === "not_found"
                    ? "NOT_FOUND"
                    : "PRECONDITION_FAILED",
              message: `mailbox_erasure_${error.code}`,
            });
          }
        } else {
          // Legacy deployments keep their baseline, without requiring optional Mail tables/SDK seams.
          if (ctx.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
          if (env.IS_CLOUD) await deps.cancelSubscription(ctx.db, ctx.teamId);
          deleted = await ctx.db.transaction(deleteRows);
        }
        const { domains, logoUrl, name } = deleted;
        await Promise.allSettled([
          ...domains.map((domain) =>
            deps.deleteSesIdentity({
              name: domain.name,
              region: domain.region,
              ...(domain.sesTenantAssociatedAt ? { tenant: ctx.teamId } : {}),
            }),
          ),
          ...(logoUrl ? [deps.deleteLogo(logoUrl)] : []),
        ]);
        // Tenants are regional and outlive the domains that created them (a
        // tenant created before a failed association, or in a region whose
        // last domain was deleted earlier), so try every region; a missing
        // tenant is tolerated.
        await Promise.allSettled(
          SES_REGIONS.map((region) => deps.deleteSesTenant({ tenantName: ctx.teamId, region })),
        );
        await recordAudit(ctx, {
          action: "team.deleted",
          target: { type: "team", id: ctx.teamId },
          metadata: { name },
        });
        return { teamId: ctx.teamId };
      }),
    }),

    members: router({
      list: teamProcedure.query(async ({ ctx }) => {
        const rows = await ctx.db
          .select({
            userId: schema.teamMembers.userId,
            name: schema.user.name,
            email: schema.user.email,
            role: schema.teamMembers.role,
          })
          .from(schema.teamMembers)
          .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
          .where(eq(schema.teamMembers.teamId, ctx.teamId))
          .orderBy(asc(schema.teamMembers.createdAt));
        return rows.map((row) => ({ ...row, self: row.userId === ctx.session.user.id }));
      }),

      // Admins manage members and admins; only owners touch the owner role.
      updateRole: teamProcedure
        .input(z.object({ userId: z.string().min(1), role: z.enum(["owner", "admin", "member"]) }))
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          const target = await findMembership(ctx.db, ctx.teamId, input.userId);
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.operationsAccess && input.role !== "member") {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message:
                "Remove the restricted operational membership before granting an administrative team role.",
            });
          }
          if ((target.role === "owner" || input.role === "owner") && ctx.role !== "owner") {
            throw new TRPCError({ code: "FORBIDDEN" });
          }
          if (target.role === "owner" && input.role !== "owner") {
            await assertAnotherOwner(ctx.db, ctx.teamId, input.userId);
          }
          await ctx.db
            .update(schema.teamMembers)
            .set({ role: input.role })
            .where(eq(schema.teamMembers.id, target.id));
          await recordAudit(ctx, {
            action: "member.role_changed",
            target: { type: "user", id: input.userId },
            metadata: { from: target.role, to: input.role },
          });
          return { userId: input.userId, role: input.role };
        }),

      remove: teamProcedure
        .input(z.object({ userId: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          if (input.userId === ctx.session.user.id) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Leave the team instead." });
          }
          const target = await findMembership(ctx.db, ctx.teamId, input.userId);
          if (!target) throw new TRPCError({ code: "NOT_FOUND" });
          if (target.role === "owner") {
            if (ctx.role !== "owner") throw new TRPCError({ code: "FORBIDDEN" });
            await assertAnotherOwner(ctx.db, ctx.teamId, input.userId);
          }
          await removeMembership(ctx.db, ctx.teamId, input.userId);
          await recordAudit(ctx, {
            action: "member.removed",
            target: { type: "user", id: input.userId },
            metadata: { role: target.role },
          });
          return { userId: input.userId };
        }),

      leave: teamProcedure.mutation(async ({ ctx }) => {
        if (ctx.role === "owner") await assertAnotherOwner(ctx.db, ctx.teamId, ctx.session.user.id);
        await removeMembership(ctx.db, ctx.teamId, ctx.session.user.id);
        await recordAudit(ctx, {
          action: "member.left",
          target: { type: "user", id: ctx.session.user.id },
          metadata: { role: ctx.role },
        });
        return { teamId: ctx.teamId };
      }),
    }),

    invitations: router({
      // Owner/admin only, like create and revoke. The accept link is handed out
      // once, at create time: a listing that could reproduce every pending
      // bearer link would make one admin session worth every open invite.
      list: teamProcedure.query(({ ctx }) => {
        assertCanManageMembers(ctx.role);
        return listPendingInvitations(ctx.db, ctx.teamId);
      }),

      create: teamProcedure
        .input(
          z.object({
            email: inviteEmailSchema,
            role: inviteRoleSchema,
          }),
        )
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          const created = await createInvitation(ctx.db, mail, {
            teamId: ctx.teamId,
            email: input.email,
            role: input.role,
            inviter: ctx.session.user,
          });
          await recordAudit(ctx, {
            action: "member.invited",
            target: { type: "invitation", id: created.id },
            metadata: { email: input.email, role: input.role, emailed: created.emailed },
          });
          return created;
        }),

      revoke: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
        assertCanManageMembers(ctx.role);
        const row = await revokeInvitation(ctx.db, { teamId: ctx.teamId, id: input.id });
        await recordAudit(ctx, {
          action: "invitation.revoked",
          target: { type: "invitation", id: row.id },
        });
        return { id: row.id };
      }),

      resend: teamProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
        assertCanManageMembers(ctx.role);
        const sent = await resendInvitation(ctx.db, mail, {
          teamId: ctx.teamId,
          id: input.id,
          inviter: ctx.session.user,
        });
        await recordAudit(ctx, {
          action: "invitation.resent",
          target: { type: "invitation", id: sent.id },
          metadata: { email: sent.email },
        });
        return { id: sent.id, expiresAt: sent.expiresAt };
      }),

      /**
       * What the accept page shows before the visitor signs in: who invited
       * them where, and whether the link is still good. The signed token is
       * the credential, so no session is required.
       */
      preview: publicProcedure
        .input(z.object({ token: z.string().min(1) }))
        .query(async ({ ctx, input }) => {
          const inviteId = verifyInviteToken(input.token, inviteSecret());
          if (!inviteId)
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });
          const [row] = await ctx.db
            .select({
              email: schema.teamInvitations.email,
              role: schema.teamInvitations.role,
              expiresAt: schema.teamInvitations.expiresAt,
              acceptedAt: schema.teamInvitations.acceptedAt,
              operationsAccess: schema.teamInvitations.operationsAccess,
              teamName: schema.teams.name,
              inviterName: schema.user.name,
            })
            .from(schema.teamInvitations)
            .innerJoin(schema.teams, eq(schema.teams.id, schema.teamInvitations.teamId))
            .leftJoin(schema.user, eq(schema.user.id, schema.teamInvitations.invitedByUserId))
            .where(eq(schema.teamInvitations.id, inviteId));
          if (!row) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });
          const state = row.acceptedAt
            ? ("accepted" as const)
            : row.expiresAt.getTime() <= Date.now()
              ? ("expired" as const)
              : ("valid" as const);
          // On cloud the address is masked and never prefilled: sign-up needs
          // no verification, so a leaked link plus the plain address would let
          // anyone register as the invitee and take the seat. Self-host keeps
          // the link as the credential by design, so the address shows.
          const cloud = Boolean(env.IS_CLOUD);
          return {
            teamName: row.teamName,
            inviterName: row.inviterName ?? null,
            role: row.role,
            operationsProfile: Boolean(row.operationsAccess),
            email: cloud ? maskEmail(row.email) : row.email,
            prefillEmail: cloud ? null : row.email,
            expiresAt: row.expiresAt,
            state,
          };
        }),

      /**
       * The authenticated caller joins the invite's team with its role. teamId
       * comes only from the invite row. On cloud the caller's account email must
       * match the invited address, so a forwarded or leaked link is worthless to
       * anyone else. Self-host keeps the signed link as the sole credential:
       * operators routinely invite an address the new user then signs up under
       * verbatim, and there is no email verification to lean on. Single-use is
       * atomic — acceptedAt is stamped in the same conditional update, so a
       * second accept finds nothing to stamp.
       */
      accept: protectedProcedure
        .input(z.object({ token: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          const inviteId = verifyInviteToken(input.token, inviteSecret());
          if (!inviteId)
            throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });

          if (env.IS_CLOUD) {
            const [invite] = await ctx.db
              .select({ email: schema.teamInvitations.email })
              .from(schema.teamInvitations)
              .where(eq(schema.teamInvitations.id, inviteId));
            if (invite && invite.email.toLowerCase() !== ctx.session.user.email.toLowerCase()) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "This invitation was sent to a different email address.",
              });
            }
          }

          const joined = await ctx.db.transaction(async (tx) => {
            const [claimed] = await tx
              .update(schema.teamInvitations)
              .set({ acceptedAt: new Date() })
              .where(
                and(
                  eq(schema.teamInvitations.id, inviteId),
                  isNull(schema.teamInvitations.acceptedAt),
                  gt(schema.teamInvitations.expiresAt, new Date()),
                ),
              )
              .returning({
                teamId: schema.teamInvitations.teamId,
                role: schema.teamInvitations.role,
                email: schema.teamInvitations.email,
                invitedByUserId: schema.teamInvitations.invitedByUserId,
                operationsAccess: schema.teamInvitations.operationsAccess,
              });
            if (!claimed)
              throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid invitation." });

            await tx
              .insert(schema.teamMembers)
              .values({ teamId: claimed.teamId, userId: ctx.session.user.id, role: claimed.role })
              .onConflictDoNothing({
                target: [schema.teamMembers.teamId, schema.teamMembers.userId],
              });
            const operations = await activateOperationsInvitation(
              tx as unknown as Db,
              ctx.session.user.id,
              claimed,
            );
            return { teamId: claimed.teamId, role: claimed.role, operations };
          });

          ctx.setActiveTeamCookie?.(joined.teamId);
          await recordAudit(
            { ...ctx, teamId: joined.teamId },
            {
              action: "member.joined",
              target: { type: "user", id: ctx.session.user.id },
              metadata: {
                role: joined.role,
                invitationId: inviteId,
                ...(joined.operations
                  ? {
                      operationalProfile: true,
                      domainIds: joined.operations.domainIds,
                      sendMailboxIds: joined.operations.sendMailboxIds,
                      approvedBy: joined.operations.issuer,
                    }
                  : {}),
              },
            },
          );
          return { teamId: joined.teamId };
        }),
    }),

    smtp: router({
      // Read-only connection facts. The password is deliberately the literal
      // placeholder, never a real key: the SMTP relay authenticates with any
      // ms_ API key, which the operator mints on the API keys screen.
      get: teamProcedure.query(() => {
        // Same gate as the tab and the page: on cloud an unexposed relay has no
        // connection details to hand out, only a hostname that cannot answer.
        if (!smtpRelayOffered()) throw new TRPCError({ code: "NOT_FOUND" });
        return {
          host: smtpPublicHost(),
          // Raw process.env carries no zod default under SKIP_ENV_VALIDATION, so
          // fall back to the relay's default listen port.
          port: Number(env.SMTP_PORT) || 2587,
          user: "mepmail",
          passwordPlaceholder: SMTP_PASSWORD_PLACEHOLDER,
          // Mirrors the relay's AUTH gate (apps/smtp/src/server.ts): AUTH needs
          // STARTTLS (cert+key both set) unless the insecure escape hatch is on.
          // Booleans only — the cert paths never reach the client. Raw process.env
          // for the flag because under SKIP_ENV_VALIDATION the env proxy carries
          // strings, not zod-parsed booleans.
          tlsConfigured: Boolean(env.SMTP_TLS_CERT_PATH && env.SMTP_TLS_KEY_PATH),
          allowInsecureAuth:
            process.env.SMTP_ALLOW_INSECURE_AUTH === "true" ||
            process.env.SMTP_ALLOW_INSECURE_AUTH === "1",
        };
      }),
    }),

    /**
     * The owner notices this person receives, across every team they own.
     * Stored as the keys turned off, so a switch added later is on for
     * everyone; the writes are jsonb set operations, so two tabs toggling
     * at once cannot undo each other.
     */
    mailPreferences: router({
      get: protectedProcedure.query(async ({ ctx }) => {
        return { optOuts: await mailOptOuts(ctx.db, ctx.session.user.id) };
      }),

      set: protectedProcedure
        .input(
          z.object({
            key: z.enum(MAIL_PREFERENCE_KEYS as [MailPreferenceKey, ...MailPreferenceKey[]]),
            enabled: z.boolean(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const u = schema.user;
          const without = sql`${u.mailOptOuts} - ${input.key}`;
          await ctx.db
            .update(u)
            .set({
              mailOptOuts: input.enabled
                ? without
                : sql`(${without}) || ${JSON.stringify([input.key])}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(u.id, ctx.session.user.id));
          return { optOuts: await mailOptOuts(ctx.db, ctx.session.user.id) };
        }),
    }),

    unsubscribe: router({
      get: teamProcedure.query(async ({ ctx }) => {
        const [team] = await ctx.db
          .select({
            // The page falls back to the team name when no brand name is set;
            // the editor shows it as the placeholder rather than a stored value
            // so a later team rename keeps flowing through.
            teamName: schema.teams.name,
            brandName: schema.teams.unsubscribeBrandName,
            message: schema.teams.unsubscribeMessage,
            successMessage: schema.teams.unsubscribeSuccessMessage,
            redirectUrl: schema.teams.unsubscribeRedirectUrl,
            backgroundColor: schema.teams.unsubscribeBackgroundColor,
            textColor: schema.teams.unsubscribeTextColor,
            accentColor: schema.teams.unsubscribeAccentColor,
            hideBranding: schema.teams.unsubscribeHideBranding,
            logoRadius: schema.teams.unsubscribeLogoRadius,
            poweredBy: schema.teams.unsubscribePoweredBy,
            plan: schema.teams.plan,
            currentPeriodEnd: schema.teams.currentPeriodEnd,
          })
          .from(schema.teams)
          .where(eq(schema.teams.id, ctx.teamId));
        if (!team) throw new TRPCError({ code: "NOT_FOUND" });
        const { plan, currentPeriodEnd, ...cfg } = team;
        const locked = poweredByLocked({ plan, currentPeriodEnd });
        return { ...cfg, poweredBy: cfg.poweredBy || locked, poweredByLocked: locked };
      }),

      update: teamProcedure
        .input(
          z.object({
            brandName: nullableText(80),
            message: nullableText(500),
            successMessage: nullableText(500),
            redirectUrl: nullableHttpUrl,
            backgroundColor: nullableHexColor,
            textColor: nullableHexColor,
            accentColor: nullableHexColor,
            hideBranding: z.boolean(),
            logoRadius: z.enum(schema.unsubscribeLogoRadiusEnum.enumValues),
            poweredBy: z.boolean(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          assertCanManageMembers(ctx.role);
          const [team] = await ctx.db
            .select({ plan: schema.teams.plan, currentPeriodEnd: schema.teams.currentPeriodEnd })
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          // A plan that cannot hide the line keeps it on, whatever was sent.
          const poweredBy = input.poweredBy || poweredByLocked(team);
          await ctx.db
            .update(schema.teams)
            .set({
              unsubscribeBrandName: input.brandName,
              unsubscribeMessage: input.message,
              unsubscribeSuccessMessage: input.successMessage,
              unsubscribeRedirectUrl: input.redirectUrl,
              unsubscribeBackgroundColor: input.backgroundColor,
              unsubscribeTextColor: input.textColor,
              unsubscribeAccentColor: input.accentColor,
              unsubscribeHideBranding: input.hideBranding,
              unsubscribeLogoRadius: input.logoRadius,
              unsubscribePoweredBy: poweredBy,
            })
            .where(eq(schema.teams.id, ctx.teamId));
          return { ...input, poweredBy };
        }),
    }),

    usage: router({
      recent: teamProcedure
        .input(z.object({ days: z.number().int().min(1).max(30).optional() }).optional())
        .query(async ({ ctx, input }) => {
          const days = input?.days ?? 15;
          const today = utcDay(Date.now());
          const since = utcDay(Date.now() - (days - 1) * DAY_MS);

          const [team] = await ctx.db
            .select(QUOTA_COLUMNS)
            .from(schema.teams)
            .where(eq(schema.teams.id, ctx.teamId));
          if (!team) throw new TRPCError({ code: "NOT_FOUND" });
          // The API enforces plan caps only on cloud; self-host reports none.
          const quota = teamQuota(team, env.IS_CLOUD);

          const c = schema.usageCounters;
          const rows = await ctx.db
            .select({
              day: c.day,
              accepted: c.accepted,
              sent: c.sent,
              delivered: c.delivered,
              bounced: c.bounced,
              complained: c.complained,
            })
            .from(c)
            .where(and(eq(c.teamId, ctx.teamId), gte(c.day, since)))
            .orderBy(desc(c.day));

          const period =
            quota.kind === "month"
              ? {
                  accepted: (await readPeriodUsage(ctx.db, ctx.teamId, quota.periodStart)).accepted,
                  included: quota.included,
                  start: quota.periodStart,
                  end: quota.periodEnd,
                  overage: quota.overage,
                }
              : null;
          return {
            rows,
            today: {
              accepted: rows.find((r) => r.day === today)?.accepted ?? 0,
              limit: quota.kind === "day" ? quota.limit : null,
            },
            /** The billing period a monthly plan counts against; null on a daily cap or self-host. */
            period,
          };
        }),
    }),
  });
}

/** The keys a person turned off, as stored; a key the app no longer knows is dropped on read. */
async function mailOptOuts(db: Db, userId: string): Promise<MailPreferenceKey[]> {
  const [row] = await db
    .select({ optOuts: schema.user.mailOptOuts })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return (row?.optOuts ?? []).filter(isMailPreferenceKey);
}

export const settingsRouter = createSettingsRouter();
