import {
  canReadUserDirectory,
  MailboxRecipientBlockedError,
  parseOperationsAccess,
  recordSupportViewRead,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { getDb } from "@millionsend/db";
import { initTRPC, TRPCError } from "@trpc/server";
import { cookies } from "next/headers";
import superjson from "superjson";
import { isAndroidAppRequest } from "@/lib/android-app";
import { getAuth } from "./auth";
import { isInstanceOperator } from "./instance-operator";
import { ACTIVE_TEAM_COOKIE, getActiveMembership, type SessionRole } from "./membership";
import { recordProcedureTiming, timedProcedure } from "./procedure-timings";
import { enqueueEmailSend, enqueueWebhookDeliveries, getQueue } from "./queue";
import { resolveRequestMembership } from "./request-membership";
import { resolveSupportView, SUPPORT_VIEW_COOKIE } from "./support-view";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Structural subset of Better Auth's session payload — kept minimal so
 * tests can fake an authenticated context without constructing real
 * sessions.
 */
export interface AuthSession {
  user: SessionUser;
  /** The session row; optional so tests can fake a context without one. */
  session?: { id: string; createdAt?: Date };
}

/** The read-only view a request runs under: the team is the grant's and the role is viewer. */
export interface SupportViewContext {
  grantId: string;
  expiresAt: Date;
}

export interface Context {
  db: Db;
  session: AuthSession | null;
  teamId: string | null;
  role: SessionRole | null;
  /** The request came from the Android app (lib/android-app.ts): nothing is sold there. */
  androidApp?: boolean;
  /** Set only while the session user's own live grant names the team; every mutation is refused. */
  supportView?: SupportViewContext | undefined;
  /** Persists the team selection (ACTIVE_TEAM_COOKIE). Absent outside HTTP requests (tests). */
  setActiveTeamCookie?: (teamId: string) => void;
  /** Names the live grant (SUPPORT_VIEW_COOKIE), or clears it with null. Absent in tests. */
  setSupportViewCookie?: (grant: { id: string; expiresAt: Date } | null) => void;
  /**
   * Hands a scheduled broadcast to the fan-out queue (same optional seam as
   * the API's ApiDeps.enqueueBroadcastSend). Absent in tests; without it a
   * send still commits and the broadcasts.reconcile sweep picks it up.
   */
  enqueueBroadcastSend?: (broadcastId: string, opts?: { startAfter?: Date }) => Promise<void>;
  /** Hands an accepted email to the send queue (the onboarding send). Absent in tests. */
  enqueueEmailSend?: (emailId: string) => Promise<void>;
  /**
   * Hands a webhook delivery row to the delivery queue, for the contact and
   * suppression events the routers publish. Absent in tests; the
   * webhooks.reconcile sweep sends rows nobody enqueued.
   */
  enqueueWebhookDeliveries?: WebhookEnqueue;
}

const enqueueBroadcastSend = async (
  broadcastId: string,
  opts?: { startAfter?: Date },
): Promise<void> => {
  const queue = await getQueue();
  await queue.send(
    "broadcast.send",
    { broadcastId },
    { dedupeKey: broadcastId, ...(opts?.startAfter ? { startAfter: opts.startAfter } : {}) },
  );
};

export async function createContext({ headers }: { headers: Headers }): Promise<Context> {
  const db = getDb();
  const session = await getAuth().api.getSession({ headers });
  const androidApp = isAndroidAppRequest(headers);
  if (!session) return { db, session: null, teamId: null, role: null, androidApp };
  const cookieStore = await cookies();
  const secure = process.env.NODE_ENV === "production";
  const shared = {
    db,
    session,
    androidApp,
    enqueueBroadcastSend,
    enqueueEmailSend,
    enqueueWebhookDeliveries,
    setActiveTeamCookie: (teamId: string) =>
      cookieStore.set(ACTIVE_TEAM_COOKIE, teamId, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure,
        maxAge: 60 * 60 * 24 * 365,
      }),
    setSupportViewCookie: (grant: { id: string; expiresAt: Date } | null) =>
      grant
        ? cookieStore.set(SUPPORT_VIEW_COOKIE, grant.id, {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            secure,
            expires: grant.expiresAt,
          })
        : cookieStore.delete(SUPPORT_VIEW_COOKIE),
  };
  const viewCookie = cookieStore.get(SUPPORT_VIEW_COOKIE)?.value;
  const view = await resolveSupportView(db, session.user.id, viewCookie);
  if (view) {
    return {
      ...shared,
      teamId: view.teamId,
      role: "viewer",
      supportView: { grantId: view.grantId, expiresAt: view.expiresAt },
    };
  }
  // A cookie that no longer names a live grant of this user is dropped, so
  // the browser stops sending it; the request falls back to the membership.
  if (viewCookie) cookieStore.delete(SUPPORT_VIEW_COOKIE);
  const membership = await getActiveMembership(
    db,
    session.user.id,
    cookieStore.get(ACTIVE_TEAM_COOKIE)?.value,
  );
  return { ...shared, teamId: membership?.teamId ?? null, role: membership?.role ?? null };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  // A send refused for recipients that bounced or complained names them, for the owner.
  errorFormatter({ shape, error }) {
    return error.cause instanceof MailboxRecipientBlockedError
      ? { ...shape, data: { ...shape.data, blockedRecipients: error.cause.recipients } }
      : shape;
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * The procedures a live view may still reach, by exact path: the operator
 * ending their own session, and the banner asking whether it still holds.
 * Named one by one rather than by prefix, so a procedure added to the
 * support router later does not inherit the exemption.
 */
const SUPPORT_VIEW_PASS: ReadonlySet<string> = new Set(["support.end", "support.current"]);

/**
 * Read-only support view, enforced once for every procedure: a mutation is
 * refused whatever the router hides or disables, and each read is counted
 * on the grant by procedure path. The console's own procedures pass
 * untouched and uncounted — the operator is still the operator, and a
 * console read is not a read of the team — and so do the two procedures
 * above, which are about the session rather than the team's data.
 */
const supportViewGuard = t.middleware(async ({ ctx, type, path, next }) => {
  const view = ctx.supportView;
  if (!view || path.startsWith("console.") || SUPPORT_VIEW_PASS.has(path)) return next();
  if (type === "mutation") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Read-only support view" });
  }
  if (type === "query") await recordSupportViewRead(ctx.db, view.grantId, path);
  return next();
});

/** Server time of the Correio procedures, logged in aggregate (procedure-timings.ts). */
const procedureTiming = t.middleware(async ({ path, next }) => {
  if (!timedProcedure(path)) return next();
  const started = performance.now();
  const result = await next();
  recordProcedureTiming(path, performance.now() - started, result.ok);
  return result;
});

export const publicProcedure = t.procedure.use(procedureTiming).use(supportViewGuard);

/**
 * Google Play's payments policy: nothing is sold inside the Android app. The app marks its
 * requests (lib/android-app.ts), and every purchase or plan change from it is refused here,
 * whatever a hidden link or a deep link tries. The mark can only take a right away.
 * Cancelling a renewal is not a purchase and stays open (billing.cancelRenewal, and the
 * "cancel" action of mailboxes.manage).
 */
export const ANDROID_PURCHASE_REFUSED = "Purchases are not available in the Android app.";
export const noPurchaseInAndroidApp = t.middleware(({ ctx, next }) => {
  if (ctx.androidApp) throw new TRPCError({ code: "FORBIDDEN", message: ANDROID_PURCHASE_REFUSED });
  return next();
});

/**
 * An operational member is deliberately narrower than a normal member of this
 * team. These exact procedure/type pairs are the whole delegated surface; a new
 * endpoint never inherits access from a router prefix. Mailbox ACLs still make
 * the final decision for every selected box and every queued send.
 */
const OPERATIONS_QUERIES: ReadonlySet<string> = new Set([
  "console.users.list",
  "mailboxes.activity",
  "mailboxes.capabilities",
  "mailboxes.folderCounts",
  "mailboxes.folders",
  "mailboxes.item",
  "mailboxes.items",
  "mailboxes.list",
  "mailboxes.options",
  "mailboxes.preferences.get",
  "mailboxes.scheduling.counts",
  "mailboxes.search",
  "mailboxes.senders.list",
  "mailboxes.thread",
  "mailboxes.unreadCounts",
  "settings.mailPreferences.get",
  "settings.team.get",
  "support.current",
  "system.features",
  "system.operator",
  "system.sendingPaused",
  "team.list",
]);
const OPERATIONS_MUTATIONS: ReadonlySet<string> = new Set([
  "mailboxes.archiveFolder",
  "mailboxes.create",
  "mailboxes.createFolder",
  "mailboxes.preferences.set",
  "mailboxes.purgeTrash",
  "mailboxes.queueDraft",
  "mailboxes.reorderFolders",
  "mailboxes.saveDraft",
  "mailboxes.scheduling.followUp",
  "mailboxes.scheduling.pin",
  "mailboxes.scheduling.sendLater",
  "mailboxes.scheduling.snooze",
  "mailboxes.senders.decide",
  "mailboxes.setArchive",
  "mailboxes.setDeliveryFolder",
  "mailboxes.setItemFolder",
  "mailboxes.setSeen",
  "mailboxes.setSeenMany",
  "mailboxes.setStar",
  "mailboxes.setTrash",
  "mailboxes.updateFolder",
  "mailboxes.updateSignature",
  "settings.invitations.accept",
  "settings.mailPreferences.set",
  "support.end",
  "team.switch",
]);

export const protectedProcedure = publicProcedure.use(async ({ ctx, type, path, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  // The request context may have been prepared before a revocation or profile
  // change. Resolve the current row here, including for session-only endpoints
  // such as OAuth consent which never go through teamProcedure.
  const requestMembership = await resolveRequestMembership(ctx);
  if (requestMembership && requestMembership.operationsAccess !== null) {
    const access = parseOperationsAccess(requestMembership.operationsAccess);
    const permitted =
      type === "query"
        ? OPERATIONS_QUERIES.has(path)
        : type === "mutation" && OPERATIONS_MUTATIONS.has(path);
    if (
      requestMembership.role !== "member" ||
      !requestMembership.verified ||
      requestMembership.suspendedAt ||
      !access ||
      !permitted
    ) {
      throw new TRPCError({ code: path.startsWith("console.") ? "NOT_FOUND" : "FORBIDDEN" });
    }
  }
  return next({ ctx: { session: ctx.session, requestMembership: requestMembership ?? null } });
});

/**
 * Membership-scoped procedures: teamId/role derive exclusively from the
 * session's teamMembers row (never from client input) and are non-null in
 * downstream ctx. Every db query in a teamProcedure must filter by
 * ctx.teamId.
 */
export const teamProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!ctx.teamId) throw new TRPCError({ code: "FORBIDDEN" });
  // A live operator support view is intentionally not a membership. Its
  // read-only guard above remains in force; ordinary requests need the fresh
  // row, and a stale or forged role never survives it.
  const role = ctx.supportView ? ctx.role : ctx.requestMembership?.role;
  if (!role) throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx: { teamId: ctx.teamId, role } });
});

/**
 * Team administration: secrets, external sinks, and sending identities.
 * An allow-list, not a deny-list: a role added to SessionRole later must be
 * admitted here on purpose rather than by default.
 */
export const adminProcedure = teamProcedure.use(({ ctx, next }) => {
  if (ctx.role !== "owner" && ctx.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});

/**
 * The instance console: only the first registered user, re-checked on every
 * call. Anyone else gets the same NOT_FOUND a route that does not exist
 * would give, signed-in members included — the console is not a thing
 * they can see. No team scope: the console reads across every team.
 */
export const operatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!(await isInstanceOperator(ctx.db, ctx.session.user.id))) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return next({ ctx: { operator: ctx.session.user } });
});

/** This grants one read procedure, never the operator console or its mutations. */
export const usersDirectoryProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (
    !(await isInstanceOperator(ctx.db, ctx.session.user.id)) &&
    !(await canReadUserDirectory(ctx.db, ctx.session.user.id))
  ) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return next();
});
