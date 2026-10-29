import { appHostname, umamiFunnel } from "@millionsend/config";
import {
  applyStatusCas,
  buildUnsubscribeHeaders,
  buildUnsubscribeUrl,
  bumpHourlyUsage,
  CREDENTIAL_MAIL_KINDS,
  checkSignupSend,
  countDistinctRecipients,
  decryptEmailBody,
  type EmailAttachment,
  type EmailBody,
  emitFunnelEvent,
  enqueueWebhookDeliveries,
  evaluateEmailInsights,
  extractAddrSpec,
  type FunnelEventTarget,
  fetchTeamQuota,
  fetchTeamStanding,
  findSuppressed,
  getSignupSendingRestriction,
  hashRecipient,
  isOnboardingSender,
  isSubscribedToTopic,
  type Keyring,
  MONITOR_ANOMALY_CHECKS,
  type MonitorDeps,
  makeUnsubscribeToken,
  openAttachments,
  parseSingleSender,
  purgedEmailBodyColumns,
  releaseQuota,
  resolveSendingProvider,
  rewriteForTracking,
  SCORE_VERSION,
  type SendingProviderPolicy,
  SYSTEM_MAIL_TAG,
  sampleAcceptedEmail,
  substituteUnsubscribeUrl,
  transitionQueueState,
  utcDay,
  type WebhookEnqueue,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { type EmailSendPriority, emailSendPriority } from "@millionsend/queue";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { claimAzureSend } from "../../../../packages/core/src/azure-send-claim.js";
import {
  campaignMessage,
  checkCampaignMessage,
} from "../../../../packages/core/src/campaign-consent.js";
import { screenPreSendContent } from "../../../../packages/core/src/pre-send-content-policy.js";
import {
  isSesEnforcementRefusal,
  isSesQuotaRefusal,
  isSesThrottle,
  type SendQuotaControls,
} from "./ses-quota.js";

/**
 * Sends one queued email through SES. The SES client is injected (tests use
 * a fake); the job payload carries only the emailId — every fact about the
 * send is re-read from the database, never trusted from the payload.
 */

export interface SesSender {
  sendRaw(params: {
    raw: Buffer;
    /** Server-owned fallback join key copied into an SES message tag. */
    emailId: string;
    /**
     * Envelope recipients from the stored, validated fields — the sender
     * derives the SES Destination from these, never from the MIME headers.
     */
    to: string[];
    cc?: string[] | null;
    bcc?: string[] | null;
    configurationSetName?: string;
    /** SES region the sending identity is verified in; sender default when absent. */
    region?: string;
    /** The team's SES tenant; only set once the domain's resources are associated with it. */
    tenantName?: string;
    /** The From addr-spec, for the customer relay's envelope; SES and the fallback ignore it. */
    envelopeFrom?: string;
  }): Promise<{ messageId: string }>;
}

export interface SendDeps {
  sendingProviderPolicy?: SendingProviderPolicy | null;
  /** Optional fixture transport; deployment configuration is used when absent. */
  funnel?: FunnelEventTarget | undefined;
  keyring: Keyring;
  ses: SesSender;
  /** Signup restrictions are cloud-only; omitted preserves the self-host path. */
  isCloud?: boolean;
  /** Deployment-wide SES configuration set, used when the domain has none. */
  defaultConfigurationSet?: string | undefined;
  /** ONBOARDING_EMAIL_FROM: sends from it carry no team domain (see core isOnboardingSender). */
  onboardingEmailFrom?: string | undefined;
  /**
   * Awaited right before the send claim, after every check that can still
   * skip or fail the email — a token spent on a row that never reaches SES
   * is send capacity stolen from every other tenant. Takes the domain's
   * region: the send rate is per SES region.
   */
  throttle?: ((region?: string) => Promise<void>) | undefined;
  /** Re-enqueue a not-yet-due scheduled email at its due time. */
  reschedule?:
    | ((emailId: string, at: Date, priority: EmailSendPriority) => Promise<void>)
    | undefined;
  /** SES's 24-hour quota and the broadcast share; absent in tests that never reach it. */
  sesQuota?: SendQuotaControls | undefined;
  /** Legacy configured transports: an account pause never authorizes automatic use. */
  fallback?: SesSender | undefined;
  relay?: { name: string; sender: SesSender } | undefined;
  failover?: { region: string; domains: ReadonlySet<string> } | undefined;
  /** Arms the webhook drain for the endpoints written; email.sent webhooks are skipped when absent. */
  enqueueWebhookDelivery?: WebhookEnqueue | undefined;
  /**
   * RFC 8058 one-click unsubscribe config for broadcast emails. Broadcast
   * rows (contactId set) REFUSE to send without it — a marketing email must
   * never go out missing List-Unsubscribe headers.
   */
  unsubscribe?: { secretKey: Buffer; baseUrl: string } | undefined;
  /**
   * App-layer engagement tracking. secretKey signs the click/open tokens
   * (HKDF-derived from the master key); defaultBaseUrl is the tracking host
   * for domains without a custom tracking subdomain (env.APP_BASE_URL). The
   * whole dep is optional so tests that don't exercise tracking need not wire
   * it — the worker always provides it, since the master key is always present.
   */
  /**
   * The content monitor's draw on an accepted send. Absent when the judge is
   * off (and in tests that never reach it): no rows, no jobs, no state.
   */
  monitor?: MonitorDeps | undefined;
  tracking?:
    | {
        secretKey: Buffer;
        defaultBaseUrl?: string | undefined;
        /**
         * Whether a domain's branded tracking subdomain may serve as the
         * tracking origin. Omitted means yes (self-host). False routes every
         * tracked link through defaultBaseUrl instead, so a subdomain stored
         * while the feature was available cannot keep shipping links to a
         * host this deployment has no certificate for.
         */
        allowSubdomains?: boolean | undefined;
        /**
         * A tracking host shared by every tenant is what ad blockers and
         * spam filters learn to block (SES's own awstrack.me sits on the
         * popular blocklists), and its reputation bleeds across tenants.
         * True: a domain without its own subdomain ships clean links instead
         * of falling back to defaultBaseUrl.
         */
        requireBrandedHost?: boolean | undefined;
      }
    | undefined;
}

export type SendOutcome =
  | "sent"
  | "skipped"
  | "deferred"
  | "suppressed"
  | "failed"
  | "parked"
  | "canceled";

interface SendEligibility {
  eligible: boolean;
  topicId: string | null;
  reason?: string;
  /** Recipients suppressed since accept; the send drops them (accept-time strip semantics). */
  strip?: Set<string>;
}

async function checkSendEligibility(
  db: Db,
  email: typeof schema.emails.$inferSelect,
): Promise<SendEligibility> {
  if (!email.contactId) {
    // Bounces and complaints recorded after accept (a scheduled or
    // quota-parked row can wait days) are honored the way accept does:
    // strip the hit, refuse only when no primary recipient is left.
    const recipients = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])];
    const suppressed = await findSuppressed(db, email.teamId, recipients, {
      transactional: email.topicId === null,
    });
    if (suppressed.size === 0) return { eligible: true, topicId: null };
    if (email.to.every((r) => suppressed.has(r))) {
      return { eligible: false, topicId: null, reason: "recipient_suppressed" };
    }
    return { eligible: true, topicId: null, strip: suppressed };
  }

  const [contact] = await db
    .select({ email: schema.contacts.email, unsubscribed: schema.contacts.unsubscribed })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.id, email.contactId), eq(schema.contacts.teamId, email.teamId)))
    .limit(1);
  if (!contact) return { eligible: false, topicId: null, reason: "contact_missing" };
  if (contact.unsubscribed) {
    return { eligible: false, topicId: null, reason: "contact_unsubscribed" };
  }
  if (email.to.length !== 1 || hashRecipient(email.to[0] ?? "") !== hashRecipient(contact.email)) {
    return { eligible: false, topicId: null, reason: "contact_recipient_mismatch" };
  }
  if ((await findSuppressed(db, email.teamId, email.to)).size > 0) {
    return { eligible: false, topicId: null, reason: "recipient_suppressed" };
  }

  if (!email.broadcastId) return { eligible: true, topicId: null };
  const [broadcast] = await db
    .select({ topicId: schema.broadcasts.topicId, status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(
      and(eq(schema.broadcasts.id, email.broadcastId), eq(schema.broadcasts.teamId, email.teamId)),
    )
    .limit(1);
  if (!broadcast) return { eligible: false, topicId: null, reason: "broadcast_missing" };
  // A row a walk page or a drain release committed after the stop: the
  // audience was told nothing more goes out.
  if (broadcast.status === "canceled") {
    return { eligible: false, topicId: null, reason: "broadcast_canceled" };
  }
  if (!broadcast.topicId) return { eligible: true, topicId: null };

  const [topic] = await db
    .select({ defaultSubscribed: schema.topics.defaultSubscribed })
    .from(schema.topics)
    .where(and(eq(schema.topics.id, broadcast.topicId), eq(schema.topics.teamId, email.teamId)))
    .limit(1);
  if (!topic) return { eligible: false, topicId: broadcast.topicId, reason: "topic_missing" };
  const [override] = await db
    .select({ subscribed: schema.contactTopicSubscriptions.subscribed })
    .from(schema.contactTopicSubscriptions)
    .where(
      and(
        eq(schema.contactTopicSubscriptions.contactId, email.contactId),
        eq(schema.contactTopicSubscriptions.topicId, broadcast.topicId),
      ),
    )
    .limit(1);
  if (!isSubscribedToTopic(override?.subscribed, topic.defaultSubscribed)) {
    return { eligible: false, topicId: broadcast.topicId, reason: "topic_unsubscribed" };
  }
  return { eligible: true, topicId: broadcast.topicId };
}

async function suppressQueuedEmail(db: Db, emailId: string, reason: string): Promise<boolean> {
  const [updated] = await db
    .update(schema.emails)
    .set({ latestStatus: "suppressed" })
    .where(
      and(
        eq(schema.emails.id, emailId),
        eq(schema.emails.latestStatus, "queued"),
        isNull(schema.emails.sentAt),
      ),
    )
    .returning({ id: schema.emails.id });
  if (!updated) return false;
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "suppressed",
    occurredAt: new Date(),
    data: { source: "worker", reason },
  });
  return true;
}

/** Drops suppressed recipients from the row (and the in-memory copy the MIME is built from). */
async function stripRecipients(
  db: Db,
  email: typeof schema.emails.$inferSelect,
  suppressed: Set<string>,
): Promise<void> {
  const keep = (list: string[]): string[] => list.filter((r) => !suppressed.has(r));
  email.to = keep(email.to);
  email.cc = email.cc && keep(email.cc);
  email.bcc = email.bcc && keep(email.bcc);
  await db
    .update(schema.emails)
    .set({ to: email.to, cc: email.cc, bcc: email.bcc })
    .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
}

/**
 * Terminal failure for a still-queued email: releases any send claim, moves
 * the row to "failed" and records why. Returns false when the row already
 * left "queued" (sent, canceled, suppressed) — nothing to fail then.
 */
export async function failQueuedEmail(db: Db, emailId: string, reason: string): Promise<boolean> {
  const [updated] = await db
    .update(schema.emails)
    .set({ latestStatus: "failed", sentAt: null })
    .where(and(eq(schema.emails.id, emailId), eq(schema.emails.latestStatus, "queued")))
    .returning({ id: schema.emails.id });
  if (!updated) return false;
  await db.insert(schema.emailEvents).values({
    emailId,
    type: "failed",
    occurredAt: new Date(),
    data: { source: "worker", reason },
  });
  return true;
}

/**
 * Park a queued email as queued_quota because SES, not the plan, is out of
 * sends. Hands its reservation back (the drain reserves again on release,
 * one unit per distinct recipient, as it does for plan-parked mail) so the
 * two kinds share one drain path. A row that already left "queued" is left
 * alone.
 */
async function parkQueued(
  db: Db,
  email: { id: string; teamId: string },
  why: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const moved = await transitionQueueState(txDb, email.id, {
      from: "queued",
      to: "queued_quota",
    });
    if (!moved) return;
    // Against the same counter accept charged: on a monthly plan that is the
    // billing period, which the drain will charge again on release. The cap
    // itself is irrelevant here, so the row is read as Cloud reads it.
    const quota = await fetchTeamQuota(txDb, email.teamId, true);
    if (!quota) return;
    // As many units as the drain will reserve again (cron.ts drainOne): an email to
    // N people handed back only 1 and was then charged N again on release.
    const [row] = await txDb
      .select({ to: schema.emails.to, cc: schema.emails.cc, bcc: schema.emails.bcc })
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    const count = row ? countDistinctRecipients(row.to, row.cc, row.bcc) : 1;
    await releaseQuota(txDb, { teamId: email.teamId, count, quota });
  });
  console.warn(`email.send: ${why}, parked ${email.id}`);
}

/**
 * A queued row of a broadcast that was stopped: canceled like the rows the
 * stop swept, with its reservation handed back. A row that already left
 * "queued" is left alone.
 */
async function cancelQueuedEmail(db: Db, email: { id: string; teamId: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [row] = await txDb
      .update(schema.emails)
      .set({ latestStatus: "canceled" })
      .where(
        and(
          eq(schema.emails.id, email.id),
          eq(schema.emails.latestStatus, "queued"),
          isNull(schema.emails.sentAt),
        ),
      )
      .returning({ id: schema.emails.id });
    if (!row) return false;
    const quota = await fetchTeamQuota(txDb, email.teamId, true);
    if (quota) await releaseQuota(txDb, { teamId: email.teamId, count: 1, quota });
    return true;
  });
}

/** Header names are case-insensitive; the caller's map keeps whatever casing it sent. */
const hasListUnsubscribe = (headers: Record<string, string> | null | undefined): boolean =>
  Object.keys(headers ?? {}).some((k) => k.toLowerCase() === "list-unsubscribe");

/**
 * SES errors that no retry can fix: the message itself (MessageRejected,
 * BadRequest) or the sending identity is refused. Account enforcement
 * refusals are classified first and preserve the queue.
 */
const TERMINAL_SES_ERRORS = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "BadRequestException",
]);

/**
 * Whether an error came from infrastructure that may recover (a KMS/network
 * hiccup) rather than from the data itself. Envelope decrypt raises plain
 * Errors for a corrupt blob or unknown key version — those never heal and
 * retrying only burns KMS calls.
 */
function isTransientError(err: unknown): boolean {
  const e = err as {
    name?: string;
    syscall?: string;
    $fault?: string;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.$fault === "server" ||
    e.$retryable !== undefined ||
    (e.$metadata?.httpStatusCode ?? 0) >= 500 ||
    typeof e.syscall === "string" ||
    e.name === "TimeoutError" ||
    e.name === "AbortError"
  );
}

async function broadcastCanceled(db: Db, broadcastId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: schema.broadcasts.status })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, broadcastId))
    .limit(1);
  return row?.status === "canceled";
}

/** An ineligible row: canceled with its broadcast, suppressed for any other reason. */
async function refuse(
  db: Db,
  email: { id: string; teamId: string },
  reason: string | undefined,
): Promise<SendOutcome> {
  if (reason === "broadcast_canceled") {
    return (await cancelQueuedEmail(db, email)) ? "canceled" : "skipped";
  }
  return (await suppressQueuedEmail(db, email.id, reason ?? "ineligible"))
    ? "suppressed"
    : "skipped";
}

export async function sendEmail(
  db: Db,
  deps: SendDeps,
  payload: { emailId: string },
): Promise<SendOutcome> {
  const [email] = await db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, payload.emailId));
  // Only queued emails are sendable: quota-parked, already-sent, and failed
  // rows are skipped no matter how the job arrived.
  if (email?.latestStatus !== "queued" || email.sentAt !== null) return "skipped";
  if (email.scheduledAt && email.scheduledAt.getTime() > Date.now()) {
    // Returning without re-enqueueing would ack the job and strand the
    // email forever; hand it back to the queue for its due time.
    await deps.reschedule?.(email.id, email.scheduledAt, emailSendPriority(email));
    return "deferred";
  }
  // An operator's suspension, or a broadcast pause, holds mail the queue
  // already carries: parked like an over-quota send, and the drain skips the
  // team until the operator lifts the hold. Read per send, so it bites on the
  // next row, not the next fan-out.
  // A send-review hold (send-review) parks the same way: the mail waits for
  // the operator's release, and a suspension keeps it.
  const standing = await fetchTeamStanding(db, email.teamId);
  if (
    standing?.suspended ||
    standing?.sendReview ||
    (email.broadcastId && standing?.broadcastsPausedByOperatorAt)
  ) {
    await parkQueued(
      db,
      email,
      standing.suspended
        ? "team suspended"
        : standing.sendReview
          ? "team held for review"
          : "broadcasts paused",
    );
    return "parked";
  }

  const signupAdmission = await checkSignupSend(
    db,
    email.teamId,
    [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])],
    deps.isCloud ?? false,
  );
  if (!signupAdmission.allowed) {
    await parkQueued(db, email, signupAdmission.reason);
    return "parked";
  }

  // SES identities, the 24-hour quota and the send rate are all per region:
  // the send must target the domain's region, not a single deployment-wide
  // one, and so must the gate and bucket below. The name also seeds the
  // broadcast List-Id, so it is loaded here before header assembly, and
  // before the body decrypt: an unsendable row must not cost a KMS call on
  // every attempt.
  const domain = email.domainId
    ? (
        await db
          .select({
            name: schema.domains.name,
            status: schema.domains.status,
            sesConfigurationSet: schema.domains.sesConfigurationSet,
            region: schema.domains.region,
            clickTracking: schema.domains.clickTracking,
            openTracking: schema.domains.openTracking,
            trackingSubdomain: schema.domains.trackingSubdomain,
            trackingSubdomainSetAt: schema.domains.trackingSubdomainSetAt,
            dmarcPolicy: schema.domains.dmarcPolicy,
            dmarcCheckedAt: schema.domains.dmarcCheckedAt,
            sesTenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
            sesTenantConfigSet: schema.domains.sesTenantConfigSet,
            relayEnabledAt: schema.domains.relayEnabledAt,
            sesTenantName: schema.teams.sesTenantName,
            ownerPlan: schema.teams.plan,
          })
          .from(schema.domains)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.domains.teamId))
          .where(
            and(eq(schema.domains.id, email.domainId), eq(schema.domains.teamId, email.teamId)),
          )
      )[0]
    : undefined;
  const preliminaryRoute = resolveSendingProvider(deps.sendingProviderPolicy ?? null, {
    teamId: email.teamId,
    messageClass:
      email.broadcastId || email.contactId || email.topicId ? "campaign" : "transactional",
    createdAt: email.createdAt,
    fromAddress: extractAddrSpec(email.from).toLowerCase(),
    legacyProvider: "ses",
    availableProviders: new Set([
      "ses",
      ...(deps.relay?.name === "azure" &&
      deps.sendingProviderPolicy?.restoration &&
      (domain?.relayEnabledAt || !email.domainId)
        ? ["azure_smtp"]
        : []),
      ...(deps.relay && domain?.relayEnabledAt ? ["customer_smtp"] : []),
    ]),
  });
  if (preliminaryRoute.kind === "held") return "parked";
  const azureRoute = preliminaryRoute.provider === "azure_smtp";
  // SES at its 24-hour ceiling in this region: park before building anything,
  // the way an over-plan email parks at accept. The drain releases it as the
  // window frees. A bulk row parks earlier, at the broadcast share (or while
  // the region's broadcasts are held), so transactional mail keeps the rest.
  const bulk = email.broadcastId !== null;
  if (email.broadcastId && (await broadcastCanceled(db, email.broadcastId))) {
    return refuse(db, email, "broadcast_canceled");
  }
  // A provider/account stop is not permission to replay through another account,
  // region or relay. Capacity-only exhaustion retains its existing quota path.
  if (!azureRoute && deps.sesQuota?.accountPaused?.(domain?.region) === true) {
    await parkQueued(db, email, "SES account paused");
    if (!bulk) deps.sesQuota.noteTransactionalParked?.(domain?.region);
    return "parked";
  }
  // Account pauses never select another provider. Operator-configured customer
  // external-mailbox transports are a separate Correio adapter, not this lane.
  const region = domain?.region;
  if (!azureRoute && bulk) {
    if (deps.sesQuota?.bulkExhausted?.(region) || deps.sesQuota?.paused?.(region)) {
      await parkQueued(
        db,
        email,
        deps.sesQuota.paused?.(region) ? "region broadcasts held" : "SES bulk share reached",
      );
      return "parked";
    }
  } else if (!azureRoute && deps.sesQuota?.exhausted(region)) {
    await parkQueued(db, email, "SES 24h quota reached or account paused");
    deps.sesQuota.noteTransactionalParked?.(region);
    return "parked";
  }

  let eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) return refuse(db, email, eligibility.reason);
  if (eligibility.strip) await stripRecipients(db, email, eligibility.strip);

  // SES rejects a tenant send whose identity or configuration set is not
  // associated, so the tenant rides along only once the row is marked.
  // The shared onboarding sender is an identity of this instance's own SES
  // account: no team domain, the default region and configuration set.
  const platformSend =
    !email.domainId && (isOnboardingSender(email.from, deps.onboardingEmailFrom) || azureRoute);
  if (!platformSend && domain?.status !== "verified") {
    // Terminal, not retried: a domain demoted or deleted after accept does
    // not come back on its own, and the row would otherwise ride the retry
    // and reconcile loops until its body is purged.
    await failQueuedEmail(db, email.id, "domain_not_verified");
    return "failed";
  }
  // A domain's own set and its tenant live in its home region.
  const configurationSet = domain?.sesConfigurationSet ?? deps.defaultConfigurationSet;
  const tenantName =
    domain?.sesTenantAssociatedAt &&
    domain.sesTenantName &&
    (domain.sesTenantConfigSet ?? null) === (configurationSet ?? null)
      ? domain.sesTenantName
      : undefined;

  const { bodyCiphertext, bodyIv, bodyWrappedDek, bodyKeyVersion } = email;
  if (!bodyCiphertext || !bodyIv || !bodyWrappedDek || bodyKeyVersion === null) {
    await failQueuedEmail(db, email.id, "body_missing");
    return "failed";
  }
  let body: EmailBody;
  let attachments: EmailAttachment[] | null;
  const owner = { teamId: email.teamId, rowId: email.id };
  try {
    body = await decryptEmailBody(
      {
        ciphertext: bodyCiphertext,
        iv: bodyIv,
        wrappedDek: bodyWrappedDek,
        keyVersion: bodyKeyVersion,
      },
      deps.keyring,
      owner,
    );
    // Sealed alongside the body columns, on the same terminal/transient split.
    attachments = email.attachments
      ? await openAttachments(email.attachments, deps.keyring, owner)
      : null;
  } catch (err) {
    if (isTransientError(err)) throw err;
    await failQueuedEmail(db, email.id, "body_unreadable");
    return "failed";
  }

  // Inspect original destinations BEFORE tracking/MIME, claims or any transport.
  // Synchronous deterministic policy failures propagate before the claim: no
  // classifier outage is a clean verdict and no encrypted evidence is purged.
  if (
    deps.isCloud &&
    (
      await screenPreSendContent(db, {
        teamId: email.teamId,
        from: email.from,
        subject: email.subject,
        html: body.html,
        text: body.text,
      })
    ).action === "hold"
  ) {
    await parkQueued(db, email, "pre-send content policy");
    return "parked";
  }

  const campaignInput = {
    teamId: email.teamId,
    isCloud: deps.isCloud ?? false,
    from: email.from,
    broadcastId: email.broadcastId,
    topicId: email.topicId,
    to: email.to,
    cc: email.cc ?? undefined,
    bcc: email.bcc ?? undefined,
    subject: email.subject,
    html: body.html,
    text: body.text,
    headers: email.headers,
  };
  if (!(await checkCampaignMessage(db, campaignInput)).allowed) {
    await parkQueued(db, email, "campaign consent required");
    return "parked";
  }

  // App-layer engagement tracking: when the domain has click or open tracking
  // on, WE rewrite links through our redirect endpoint and inject our pixel
  // before the MIME is built — SES never touches the body. Both off ships the
  // raw links and no pixel (clean-links requirement).
  // Account mail (core sendSystemMail) carries live credentials — reset and
  // verification links — so its anchors are never rewritten through the
  // redirect and no pixel rides along, whatever the domain's toggles say.
  const systemMail = email.tags?.[SYSTEM_MAIL_TAG] !== undefined;
  const click = (domain?.clickTracking ?? false) && !systemMail;
  const open = (domain?.openTracking ?? false) && !systemMail;
  let html = body.html;
  let text = body.text;

  // Transactional topic send (topicId without contactId): the unsubscribe
  // token signs a contactId, so it exists only when the primary recipient
  // resolves to a contact by (team, lower(addr-spec)). Substitution runs
  // before the tracking rewrite so the expanded link can be skipped by it.
  let topicUnsubscribeToken: string | null = null;
  if (email.topicId && !email.contactId && deps.unsubscribe) {
    const addr = extractAddrSpec(email.to[0] ?? "").toLowerCase();
    const [contact] = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.teamId, email.teamId),
          sql`lower(${schema.contacts.email}) = ${addr}`,
        ),
      )
      .limit(1);
    if (contact) {
      topicUnsubscribeToken = makeUnsubscribeToken({
        contactId: contact.id,
        topicId: email.topicId,
        emailId: email.id,
        secretKey: deps.unsubscribe.secretKey,
      });
    }
  }
  if (email.topicId) {
    // No token (non-contact recipient, or unsubscribe unconfigured) → the
    // placeholders are stripped; a literal token must never reach an inbox.
    const url =
      topicUnsubscribeToken && deps.unsubscribe
        ? buildUnsubscribeUrl(deps.unsubscribe.baseUrl, topicUnsubscribeToken)
        : "";
    if (html) html = substituteUnsubscribeUrl(html, url);
    if (text) text = substituteUnsubscribeUrl(text, url);
  }
  // Captured before the tracking rewrite: insights link analysis needs the
  // hrefs the recipient actually resolves, not our wrapper URLs.
  const preTrackingHtml = html;
  let brandedHostUsed = false;
  let sharedFallbackUsed = false;
  let shippedUntracked = false;
  let trackingPending = false;
  // deps.tracking is always present in the running worker (the master key is
  // always available to derive the signing key); it is optional only so tests
  // that don't exercise tracking need not wire it, and its absence simply
  // leaves the body untouched.
  if (html && (click || open) && deps.tracking) {
    // A subdomain whose CNAME has not resolved yet (its 72h clock still armed)
    // would rewrite every link to a dead host, so until a DNS check or the
    // reverify sweep clears the clock the domain counts as having none.
    const brandedHost =
      domain?.trackingSubdomain &&
      !domain.trackingSubdomainSetAt &&
      deps.tracking.allowSubdomains !== false
        ? `https://${domain.trackingSubdomain}.${domain.name}`
        : null;
    const trackingBaseUrl =
      brandedHost ?? (deps.tracking.requireBrandedHost ? null : deps.tracking.defaultBaseUrl);
    brandedHostUsed = brandedHost !== null;
    sharedFallbackUsed = brandedHost === null && trackingBaseUrl != null;
    shippedUntracked = !trackingBaseUrl;
    trackingPending =
      shippedUntracked && !!domain?.trackingSubdomain && !!domain.trackingSubdomainSetAt;
    // A custom subdomain is self-sufficient; without one the redirect host is
    // APP_BASE_URL. Missing it would ship links pointing nowhere, so fail loud
    // — except under requireBrandedHost, where untracked is the intended
    // outcome, not an error.
    if (!trackingBaseUrl && !deps.tracking.requireBrandedHost) {
      throw new Error(
        `tracking is enabled for email ${email.id} but APP_BASE_URL is unset and the domain has no tracking subdomain`,
      );
    }
    if (trackingBaseUrl) {
      // A broadcast's (or topic send's) in-body unsubscribe link is already
      // expanded to its real URL by now, so click tracking must skip it —
      // wrapping the visible Unsubscribe link through /t/c would log a bogus
      // click.
      const skipHrefPrefix =
        (email.contactId || email.topicId) && deps.unsubscribe
          ? buildUnsubscribeUrl(deps.unsubscribe.baseUrl, "")
          : undefined;
      html = rewriteForTracking(html, {
        emailId: email.id,
        trackingBaseUrl,
        click,
        open,
        secretKey: deps.tracking.secretKey,
        ...(skipHrefPrefix ? { skipHrefPrefix } : {}),
      });
    }
  }

  // Caller-supplied headers first: every transport-owned header assigned
  // below wins on collision (reserved names are also rejected at accept —
  // defense in depth).
  const headers: Record<string, string> = {
    ...email.headers,
    "X-MepMail-Email-ID": email.id,
  };
  if (email.contactId) {
    if (!deps.unsubscribe) {
      // Throwing (before the claim) keeps the email queued and the job
      // retrying loudly rather than sending without unsubscribe headers.
      throw new Error(`email ${email.id} is a broadcast send but unsubscribe is not configured`);
    }
    Object.assign(
      headers,
      buildUnsubscribeHeaders(
        deps.unsubscribe.baseUrl,
        makeUnsubscribeToken({
          contactId: email.contactId,
          topicId: eligibility.topicId,
          emailId: email.id,
          secretKey: deps.unsubscribe.secretKey,
        }),
      ),
    );
  } else if (topicUnsubscribeToken && deps.unsubscribe && !hasListUnsubscribe(email.headers)) {
    // Topic sends carry the same RFC 8058 one-click headers as broadcasts so
    // the recipient can opt out of the topic without a global unsubscribe. A
    // sender who supplied its own pair (validated at accept) keeps it: its
    // footer link and the header then point at the same place.
    Object.assign(
      headers,
      buildUnsubscribeHeaders(deps.unsubscribe.baseUrl, topicUnsubscribeToken),
    );
  }
  // Bulk-mail class signals (RFC 2919 List-Id, RFC 3834 Auto-Submitted, and
  // Precedence) so mailbox providers file broadcasts as list mail. Only for
  // broadcast rows — transactional sends must not carry them.
  if (email.broadcastId && email.contactId) {
    if (domain?.name) headers["List-Id"] = `<${email.broadcastId}.${domain.name}>`;
    headers.Precedence = "bulk";
    headers["Auto-Submitted"] = "auto-generated";
  }

  const routingInsights = evaluateEmailInsights({
    html,
    preTrackingHtml,
    text,
    from: email.from,
    senderDomain: parseSingleSender(email.from)?.domain ?? "",
    subject: email.subject,
    finalHeaders: headers,
    hasAttachments: !!attachments?.length,
    replyTo: email.replyTo,
    isBroadcast: !!(email.contactId || email.broadcastId),
    hasTopic: !!email.topicId,
    tracking: {
      clickEnabled: click,
      openEnabled: open,
      brandedHostUsed,
      sharedFallbackUsed,
      shippedUntracked,
      trackingPending,
    },
    domainSnapshot: domain
      ? { dmarcPolicy: domain.dmarcPolicy, dmarcCheckedAt: domain.dmarcCheckedAt }
      : null,
    now: new Date(),
  });
  const route = resolveSendingProvider(deps.sendingProviderPolicy ?? null, {
    teamId: email.teamId,
    createdAt: email.createdAt,
    fromAddress: extractAddrSpec(email.from).toLowerCase(),
    messageClass:
      routingInsights.marketing || campaignMessage(campaignInput) ? "campaign" : "transactional",
    legacyProvider: "ses",
    availableProviders: new Set([
      "ses",
      ...(azureRoute ? ["azure_smtp"] : []),
      ...(deps.relay && domain?.relayEnabledAt ? ["customer_smtp"] : []),
    ]),
    blockedProviders: new Set(deps.sesQuota?.accountPaused?.(region) ? ["ses"] : []),
  });
  if (route.kind === "held") {
    if (deps.sendingProviderPolicy?.restoration) return "parked";
    await parkQueued(db, email, `sending policy: ${route.reason}`);
    return "parked";
  }

  const mime = await buildRawMime({
    from: email.from,
    to: email.to,
    ...(email.cc ? { cc: email.cc } : {}),
    ...(email.bcc ? { bcc: email.bcc } : {}),
    ...(email.replyTo ? { replyTo: email.replyTo } : {}),
    subject: email.subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    headers,
  });

  // The rate-limit wait comes before the final re-check so that check stays
  // immediately ahead of the claim.
  if (!azureRoute) await deps.throttle?.(region);

  // Re-check immediately before the atomic claim: quota delays and throttling
  // can leave a row queued long enough for a recipient to opt out after the
  // broadcast fan-out first selected them. A recipient suppressed in the
  // meantime invalidates the MIME already built, so the row is stripped and
  // handed straight back to the queue.
  eligibility = await checkSendEligibility(db, email);
  if (!eligibility.eligible) return refuse(db, email, eligibility.reason);
  if (eligibility.strip) {
    await stripRecipients(db, email, eligibility.strip);
    await deps.reschedule?.(email.id, new Date(), emailSendPriority(email));
    return "deferred";
  }
  // Revalidate every provider immediately before the claim, including a
  // review or sandbox introduced while decryption/throttling was pending.
  {
    const latest = await fetchTeamStanding(db, email.teamId);
    if (latest?.suspended || latest?.sendReview) {
      await parkQueued(db, email, latest.suspended ? "team suspended" : "team held for review");
      return "parked";
    }
    const signup = await checkSignupSend(
      db,
      email.teamId,
      [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])],
      deps.isCloud ?? false,
    );
    if (!signup.allowed) {
      await parkQueued(db, email, signup.reason);
      return "parked";
    }
  }

  if (!azureRoute && deps.sesQuota?.accountPaused?.(domain?.region) === true) {
    await parkQueued(db, email, "SES account paused");
    return "parked";
  }

  // Consent can be revoked while MIME construction or throttling waits.
  if (!(await checkCampaignMessage(db, campaignInput)).allowed) {
    await parkQueued(db, email, "campaign consent required");
    return "parked";
  }

  // Atomic claim (sentAt doubles as the claim marker): closes the
  // double-send windows — a concurrent worker on the same job, and a retry
  // after SES accepted but the post-send bookkeeping failed. Claimed rows
  // are simply skipped on the next attempt.
  if (azureRoute) {
    const claim = await claimAzureSend(db, {
      emailId: email.id,
      teamId: email.teamId,
      recipients: countDistinctRecipients(email.to, email.cc, email.bcc),
    });
    if (claim === "skipped") return "skipped";
    if (claim === "quota") {
      await deps.reschedule?.(email.id, new Date(Date.now() + 60_000), emailSendPriority(email));
      return "deferred";
    }
  } else {
    const claimed = await db
      .update(schema.emails)
      .set({ sentAt: new Date() })
      .where(
        and(
          eq(schema.emails.id, email.id),
          eq(schema.emails.latestStatus, "queued"),
          isNull(schema.emails.sentAt),
        ),
      )
      .returning({ id: schema.emails.id });
    if (claimed.length === 0) return "skipped";
  }
  // Claim acquisition also awaits the DB. A revoked approval is still a
  // proven non-send, so release this claim without purging the sealed payload.
  try {
    if (!(await checkCampaignMessage(db, campaignInput)).allowed) {
      await db
        .update(schema.emails)
        .set({ sentAt: null })
        .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
      await parkQueued(db, email, "campaign consent required");
      return "parked";
    }
  } catch (error) {
    await db
      .update(schema.emails)
      .set({ sentAt: null })
      .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
    throw error;
  }
  // The claim itself awaits the DB; an account probe may close the gate then.
  if (!azureRoute && deps.sesQuota?.accountPaused?.(domain?.region) === true) {
    await db
      .update(schema.emails)
      .set({ sentAt: null })
      .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
    await parkQueued(db, email, "SES account paused");
    return "parked";
  }

  const sender =
    route.provider === "customer_smtp" || route.provider === "azure_smtp"
      ? deps.relay?.sender
      : deps.ses;
  if (!sender) throw new Error("selected_sending_provider_unavailable");
  let messageId: string;
  try {
    ({ messageId } = await sender.sendRaw({
      raw: mime,
      emailId: email.id,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      envelopeFrom: extractAddrSpec(email.from),
      ...(configurationSet ? { configurationSetName: configurationSet } : {}),
      ...(region ? { region } : {}),
      ...(tenantName ? { tenantName } : {}),
    }));
  } catch (err) {
    // An explicit refusal proves nonacceptance; transport failure does not.
    // A permanent refusal ends the email here; an ambiguous transport error
    // keeps the claim, while a retryable explicit refusal releases it.
    // (After a SUCCESSFUL sendRaw the claim
    // is never released — a bookkeeping failure then leaves the row claimed
    // rather than risking a duplicate delivery.)
    const name = (err as { name?: string }).name ?? "";
    // SES answers MessageRejected for every message while it has paused the
    // account; a fresh account read tells that apart from a refused message,
    // and the mail parks for the drain instead of failing for good.
    if (!azureRoute && (await isSesEnforcementRefusal(err, deps.sesQuota, region))) {
      await db
        .update(schema.emails)
        .set({ sentAt: null })
        .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
      await parkQueued(db, email, "SES account paused");
      if (!bulk) deps.sesQuota?.noteTransactionalParked?.(region);
      return "parked";
    }
    if (!azureRoute && TERMINAL_SES_ERRORS.has(name)) {
      await failQueuedEmail(db, email.id, `ses_${name}`);
      return "failed";
    }
    const transport = err as { name?: string; code?: string; syscall?: string };
    if (
      transport.name === "TimeoutError" ||
      transport.name === "AbortError" ||
      transport.syscall !== undefined ||
      ["ETIMEDOUT", "ECONNRESET", "EPIPE", "ESOCKET"].includes(transport.code ?? "")
    ) {
      // Acceptance is unknown. Keep the claim so a queue retry cannot replay it.
      throw err;
    }
    // An unclassified error also has unknown acceptance. Only an explicit
    // quota/rate refusal below permits releasing this claim; never replay it
    // via another provider (SMTP included).
    if (azureRoute || (!isSesQuotaRefusal(err) && !isSesThrottle(err))) throw err;
    await db
      .update(schema.emails)
      .set({ sentAt: null })
      .where(and(eq(schema.emails.id, email.id), eq(schema.emails.latestStatus, "queued")));
    // The 24-hour quota is not a retry's problem: SES names it, or the same
    // throttling exception arrives and a fresh account read says the window
    // is full. Either way the email parks; a plain rate refusal keeps retrying.
    if (
      isSesQuotaRefusal(err) ||
      (isSesThrottle(err) && deps.sesQuota !== undefined && (await deps.sesQuota.refresh(region)))
    ) {
      await parkQueued(db, email, bulk ? "SES bulk share reached" : "SES 24h quota reached");
      if (!bulk) deps.sesQuota?.noteTransactionalParked?.(region);
      return "parked";
    }
    throw err;
  }

  // Record the join key BEFORE the status flip: an SES event can arrive
  // within milliseconds and must find the row by sesMessageId.
  // Provider has succeeded; a queued sentAt claim alone is deliberately NOT evidence.
  let firstProviderSuccess = false;
  try {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await tx
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(eq(schema.teams.id, email.teamId))
        .for("update");
      const [history] = await tx
        .select({
          prior: sql<boolean>`
        exists (select 1 from ${schema.emails} e where e.team_id = ${email.teamId}
          and e.id <> ${email.id} and e.ses_message_id is not null)
        or exists (select 1 from ${schema.usageCounters} u where u.team_id = ${email.teamId} and u.sent > 0)
        or exists (select 1 from ${schema.emailEvents} ev inner join ${schema.emails} e on e.id = ev.email_id
          where e.team_id = ${email.teamId} and e.id <> ${email.id} and ev.type = 'sent')
      `,
        })
        .from(sql`(select 1) as history`);
      await tx
        .update(schema.emails)
        .set({ sesMessageId: messageId })
        .where(eq(schema.emails.id, email.id));
      const restriction = await getSignupSendingRestriction(
        tx,
        email.teamId,
        deps.isCloud ?? false,
      );
      firstProviderSuccess = !history?.prior && !systemMail && restriction.kind === "none";
    });
  } catch (error) {
    // Measurement failure must not lose the real provider join key or retry the delivery.
    console.error("first_send funnel skipped", error);
    await db
      .update(schema.emails)
      .set({ sesMessageId: messageId })
      .where(eq(schema.emails.id, email.id));
  }
  await applyStatusCas(db, email.id, "sent");
  await db.insert(schema.emailEvents).values({
    emailId: email.id,
    type: "sent",
    occurredAt: new Date(),
    data: { source: "worker" },
  });
  const counter = schema.usageCounters;
  const sentAt = new Date();
  await db
    .insert(counter)
    .values({ teamId: email.teamId, day: utcDay(sentAt), sent: 1 })
    .onConflictDoUpdate({
      target: [counter.teamId, counter.day],
      set: { sent: sql`${counter.sent} + 1` },
    });
  await bumpHourlyUsage(db, { teamId: email.teamId, at: sentAt, counts: { sent: 1 } });
  if (bulk) deps.sesQuota?.noteBulkSent?.(region);
  // The provider join key and sent status/counters are committed before network telemetry.
  // Never hold a team row lock or a SQL transaction while waiting for the collector.
  if (firstProviderSuccess) {
    try {
      const configured = umamiFunnel();
      await emitFunnelEvent(db, deps.funnel ?? { ...configured, hostname: appHostname() }, {
        name: "first_send",
        dedupeKey: `first_send:${email.teamId}`,
        teamId: email.teamId,
        props: { product: "send", measurement_version: "2" },
      });
    } catch {
      console.warn("first_send telemetry unavailable after provider success");
    }
  }
  // Credential-bearing account mail loses its body the moment SES holds it: a
  // reset link is live for thirty minutes, and the row's body is otherwise
  // readable by every member of the owning team, any full-access key and
  // any connected app until the retention purge. Recipient, subject, status,
  // events and counters stay; insights below evaluate the in-memory body.
  // Other system kinds carry only dashboard links and keep their body for the
  // normal retention window.
  if (systemMail && CREDENTIAL_MAIL_KINDS.has(email.tags?.[SYSTEM_MAIL_TAG] ?? "")) {
    await db
      .update(schema.emails)
      .set(purgedEmailBodyColumns(new Date()))
      .where(eq(schema.emails.id, email.id));
  }
  // Insights are best-effort bookkeeping on an already-accepted send: a bug
  // here must never fail (and so retry) the delivery.
  let insights: ReturnType<typeof evaluateEmailInsights> | undefined;
  try {
    // Broadcast fan-out shares ONE broadcastId-keyed row, so after the first
    // completed send one indexed point-read here replaces a full engine run
    // (several whole-body regex passes) plus a no-op insert per recipient.
    // Concurrent first sends still race harmlessly into onConflictDoNothing.
    const [existing] = email.broadcastId
      ? await db
          .select({ id: schema.emailInsights.id })
          .from(schema.emailInsights)
          .where(eq(schema.emailInsights.broadcastId, email.broadcastId))
          .limit(1)
      : [];
    if (!existing) {
      insights = evaluateEmailInsights({
        html,
        preTrackingHtml,
        text,
        from: email.from,
        senderDomain: parseSingleSender(email.from)?.domain ?? "",
        subject: email.subject,
        finalHeaders: headers,
        hasAttachments: attachments !== null && attachments.length > 0,
        replyTo: email.replyTo,
        isBroadcast: email.contactId !== null || email.broadcastId !== null,
        hasTopic: email.topicId !== null,
        tracking: {
          clickEnabled: click,
          openEnabled: open,
          brandedHostUsed,
          sharedFallbackUsed,
          shippedUntracked,
          trackingPending,
        },
        domainSnapshot: domain
          ? { dmarcPolicy: domain.dmarcPolicy, dmarcCheckedAt: domain.dmarcCheckedAt }
          : null,
        now: new Date(),
      });
      const bodySize = insights.checks.find((c) => c.id === "body_size")?.detail?.htmlSizeBytes;
      // Broadcast fan-out shares ONE row (content identical modulo the
      // unsubscribe token): the first completed send writes it, the rest —
      // and the reconcile re-send path on the emailId key — conflict-skip.
      await db
        .insert(schema.emailInsights)
        .values({
          teamId: email.teamId,
          ...(email.broadcastId ? { broadcastId: email.broadcastId } : { emailId: email.id }),
          marketing: insights.marketing,
          checks: insights.checks as schema.EmailInsightCheck[],
          scoreTenths: insights.scoreTenths,
          scoreVersion: SCORE_VERSION,
          htmlSizeBytes: typeof bodySize === "number" ? bodySize : null,
          mimeSizeBytes: mime.length,
        })
        .onConflictDoNothing({
          target: email.broadcastId
            ? schema.emailInsights.broadcastId
            : schema.emailInsights.emailId,
        });
    }
  } catch (err) {
    console.error(`email.send: insights failed for ${email.id}`, err);
  }
  // The content monitor's draw, the same best-effort rule: the send is done,
  // a failure here is logged and changes nothing. The instance's own account
  // mail is never customer content, so it is never drawn.
  if (deps.monitor && !systemMail) {
    try {
      await sampleAcceptedEmail(db, deps.monitor, {
        teamId: email.teamId,
        emailId: email.id,
        broadcast: email.broadcastId !== null,
        anomalies:
          insights?.checks.filter(
            (c) =>
              c.status === "fail" && (MONITOR_ANOMALY_CHECKS as readonly string[]).includes(c.id),
          ).length ?? 0,
      });
    } catch (err) {
      console.error(`email.send: monitor draw failed for ${email.id}`, err);
    }
  }
  // The sentAt claim above makes this path single-shot per email, so the
  // email.sent fan-out cannot double-fire on a job retry.
  if (deps.enqueueWebhookDelivery) {
    await enqueueWebhookDeliveries(db, {
      teamId: email.teamId,
      email: { emailId: email.id, from: email.from, to: email.to, subject: email.subject },
      type: "email.sent",
      occurredAt: new Date(),
      enqueue: deps.enqueueWebhookDelivery,
    });
  }
  return "sent";
}

interface MimeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  headers: Record<string, string>;
}

async function buildRawMime(input: MimeInput): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: input.from,
    to: input.to,
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.bcc ? { bcc: input.bcc } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: input.subject,
    ...(input.html ? { html: input.html } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.attachments
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            encoding: "base64" as const,
            ...(a.contentType ? { contentType: a.contentType } : {}),
          })),
        }
      : {}),
    headers: input.headers,
  });
  return info.message as Buffer;
}

export interface TokenBucket {
  take(): Promise<void>;
  /** Applies from the next refill; accumulated tokens are clamped to the new rate. */
  setRate(ratePerSecond: number): void;
}

/**
 * Token bucket pinned to the account's SES send rate — the real
 * messages-per-second control (worker concurrency is NOT a rate limit;
 * that was useSend's bug). In-memory, so the single-process assumption
 * holds: N worker replicas would send at N × the configured rate.
 */
export function createTokenBucket(ratePerSecond: number): TokenBucket {
  let rate = ratePerSecond;
  let tokens = rate;
  let lastRefill = Date.now();
  return {
    setRate(next: number): void {
      rate = next;
    },
    async take(): Promise<void> {
      for (;;) {
        const now = Date.now();
        tokens = Math.min(Math.max(rate, 1), tokens + ((now - lastRefill) / 1000) * rate);
        lastRefill = now;
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / rate) * 1000)));
      }
    },
  };
}
