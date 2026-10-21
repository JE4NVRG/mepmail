import { createHash } from "node:crypto";
import { operatorAlertsSink } from "@millionsend/config";
import {
  acceptEmail,
  findSenderDomainOwner,
  type Keyring,
  OPERATOR_ALERT_ACTION,
  recordOperatorAlert,
  SYSTEM_MAIL_TAG,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { EMAIL_SEND_PRIORITY, type EmailSendPriority } from "@millionsend/queue";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  listSignupRiskReviewCandidates,
  type SignupReviewPaymentReader,
  type SignupReviewPaymentStatus,
  type SignupRiskReviewCandidate,
  signupReviewDomain,
} from "../../../../packages/core/src/signup-risk-review-digest.js";

export const SIGNUP_RISK_DIGEST_RECIPIENT = "alertas@je4ndev.com";
export const SIGNUP_RISK_DIGEST_TIME_ZONE = "America/Sao_Paulo";
export const SIGNUP_RISK_DIGEST_KIND = "signup_risk.daily_digest";
const ACCEPTED_ACTION = "signup_risk.digest_pipeline_accepted";
const DAY = 86_400_000;
const DOMAIN_LIMIT = 50;
const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: SIGNUP_RISK_DIGEST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallParts(now: Date) {
  const parts = Object.fromEntries(clock.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Resolve a wall-clock hour through the IANA zone, including any future offset change. */
function morning(date: Date): Date {
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 8);
  let at = target;
  for (let i = 0; i < 3; i += 1) {
    const p = wallParts(new Date(at));
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    at += target - wall;
  }
  return new Date(at);
}

export interface SignupRiskDigestWindow {
  day: string;
  from: Date;
  until: Date;
  periodKey: string;
}

/** A late/manual/retried job cannot create a digest outside the natural 08h hour. */
export function signupRiskDigestWindow(now: Date): SignupRiskDigestWindow | null {
  if (!Number.isFinite(now.getTime())) return null;
  const p = wallParts(now);
  if (p.hour !== 8) return null;
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const day = date.toISOString().slice(0, 10);
  return {
    day,
    from: morning(new Date(date.getTime() - DAY)),
    until: morning(date),
    periodKey: `${SIGNUP_RISK_DIGEST_TIME_ZONE}:${day}:${SIGNUP_RISK_DIGEST_RECIPIENT}`,
  };
}

export function canRunSignupRiskDigest(isCloud: boolean, processSelection?: string): boolean {
  return isCloud && ["all", "worker"].includes(processSelection ?? "all");
}

export interface SignupRiskDigestSummary {
  pending: number;
  paidAffected: number;
  paymentUnconfirmed: number;
  newSandbox: number;
  newHolds: number;
  reviewRequests: number;
  newReviewRequests: number;
  paidDomains: string[];
  domains: string[];
}

/** Explicit projection: private context, people, email addresses and IPs never enter the content. */
export function summarizeSignupRiskDigest(
  candidates: readonly SignupRiskReviewCandidate[],
  window: SignupRiskDigestWindow,
): SignupRiskDigestSummary {
  const inWindow = (value: Date | null) =>
    value !== null && value >= window.from && value < window.until;
  const domains = (rows: readonly SignupRiskReviewCandidate[]) =>
    [
      ...new Set(
        rows
          .flatMap((row) => row.domains)
          .map(signupReviewDomain)
          .filter((d) => d !== null),
      ),
    ].sort();
  const unique = [
    ...new Map(candidates.map((candidate) => [candidate.teamId, candidate])).values(),
  ];
  const paid = unique.filter((row) => row.paid);
  return {
    pending: unique.length,
    paidAffected: paid.length,
    paymentUnconfirmed: unique.filter((row) => row.paymentStatus !== "confirmed").length,
    newSandbox: unique.filter((row) => row.level === "sandbox" && inWindow(row.profileCreatedAt))
      .length,
    newHolds: unique.filter(
      (row) =>
        (row.level === "hold" && inWindow(row.profileCreatedAt)) ||
        inWindow(row.sendReviewAt) ||
        inWindow(row.suspendedAt),
    ).length,
    reviewRequests: unique.filter((row) => row.reviewRequestedAt !== null).length,
    newReviewRequests: unique.filter((row) => inWindow(row.reviewRequestedAt)).length,
    paidDomains: domains(paid),
    domains: domains(unique),
  };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
const domainLine = (domains: string[]) =>
  domains.slice(0, DOMAIN_LIMIT).join(", ") +
    (domains.length > DOMAIN_LIMIT ? ` (+${domains.length - DOMAIN_LIMIT} na fila)` : "") ||
  "sem domínio cadastrado";

export function buildSignupRiskDigest(
  summary: SignupRiskDigestSummary,
  window: SignupRiskDigestWindow,
  appBaseUrl: string,
): { subject: string; text: string; html: string; url: string } {
  const base = new URL(appBaseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    !signupReviewDomain(base.hostname)
  )
    throw new Error("signup_risk_digest_console_url_invalid");
  const url = new URL("/console/safety#signup-reviews", base).href;
  const lines = [
    `Pagantes afetados: ${summary.paidAffected}`,
    `Pagamento não confirmado nesta consulta: ${summary.paymentUnconfirmed}`,
    `Domínios de pagantes: ${domainLine(summary.paidDomains)}`,
    `Fila pendente: ${summary.pending}`,
    `Novos sandbox: ${summary.newSandbox}`,
    `Novos hold: ${summary.newHolds}`,
    `Pedidos de revisão: ${summary.reviewRequests} (novos: ${summary.newReviewRequests})`,
    `Janela: das 08h do dia anterior às 08h de ${window.day} (${SIGNUP_RISK_DIGEST_TIME_ZONE}).`,
    `Domínios na fila: ${domainLine(summary.domains)}`,
    `Abrir fila: ${url}`,
  ];
  return {
    subject: `MepMail · fila de revisão · ${window.day}`,
    text: lines.join("\n\n"),
    html: `${lines
      .map((line, index) =>
        index === 0 ? `<p><strong>${escapeHtml(line)}</strong></p>` : `<p>${escapeHtml(line)}</p>`,
      )
      .join("")}<p><a href="${escapeHtml(url)}">Abrir fila de revisão</a></p>`,
    url,
  };
}

export interface SignupRiskDigestDeps {
  isCloud: boolean;
  processSelection?: string | undefined;
  /** Existing NOTIFICATIONS_EMAIL_FROM / AUTH_EMAIL_FROM, never a new credential. */
  from: string | undefined;
  appBaseUrl: string | undefined;
  keyring: Keyring;
  /** Bounded provider evidence reader. Called only before the digest transaction. */
  readPayments?: SignupReviewPaymentReader | undefined;
  enqueueSend: (emailId: string, startAfter?: Date, priority?: EmailSendPriority) => Promise<void>;
  /** Read afresh after database waits; only tests supply a deterministic clock. */
  now?: (() => Date) | undefined;
}

export type SignupRiskDigestResult =
  | { status: "disabled" | "outside_window" | "empty" }
  | { status: "duplicate"; emailId: string | null }
  | {
      status: "pipeline_accepted";
      emailId: string;
      queued: boolean;
      summary: SignupRiskDigestSummary;
    }
  /** OPERATOR_ALERTS_SINK=audit: one operator.alert row, no e-mail. */
  | { status: "audit_recorded"; summary: SignupRiskDigestSummary };

class SignupRiskDigestWindowClosed extends Error {}

/**
 * Claim + encrypted email + audit commit together under a day/recipient/zone lock.
 * team_notifications.sent_at is an acceptance claim here, never proof of provider
 * acceptance or delivery. Those are recorded by the existing email/SES event pipeline.
 * The append-only audit survives sender-team deletion and reconciles uncertain replays.
 */
export async function sendSignupRiskDailyDigest(
  db: Db,
  deps: SignupRiskDigestDeps,
): Promise<SignupRiskDigestResult> {
  if (!canRunSignupRiskDigest(deps.isCloud, deps.processSelection)) return { status: "disabled" };
  const readNow = deps.now ?? (() => new Date());
  const window = signupRiskDigestWindow(readNow());
  if (!window) return { status: "outside_window" };
  const currentWindowOpen = (at: Date) =>
    signupRiskDigestWindow(at)?.periodKey === window.periodKey;
  const paymentEvidence = new Map<string, SignupReviewPaymentStatus>();
  const readPayments = deps.readPayments;
  if (readPayments) {
    // Network I/O must never occupy the daily lock or the accept transaction.
    // Cache by exact protected customer ID; changed/new IDs inside the lock stay unknown.
    await listSignupRiskReviewCandidates(db, readNow(), async (ids) => {
      const observed = await readPayments(ids);
      for (const id of ids) {
        const status = observed[id];
        paymentEvidence.set(
          id,
          status === "confirmed" || status === "not_observed" ? status : "unknown",
        );
      }
      return Object.fromEntries(paymentEvidence);
    });
    if (!currentWindowOpen(readNow())) return { status: "outside_window" };
  }
  const cachedPayments: SignupReviewPaymentReader = async (ids) =>
    Object.fromEntries(ids.map((id) => [id, paymentEvidence.get(id) ?? "unknown"]));
  const lock = createHash("sha256")
    .update(`${SIGNUP_RISK_DIGEST_KIND}:${window.periodKey}`)
    .digest()
    .readBigInt64BE()
    .toString();
  const result = await db
    .transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(${lock}::bigint)`);
      const afterLock = readNow();
      if (!currentWindowOpen(afterLock)) return { status: "outside_window" } as const;
      const [prior] = await tx
        .select({ emailId: sql<string | null>`${schema.auditLog.data}->>'emailId'` })
        .from(schema.auditLog)
        .where(
          and(
            // An accepted message, or the operator.alert an audit sink wrote
            // instead of one: either way this period has already been served.
            inArray(schema.auditLog.action, [ACCEPTED_ACTION, OPERATOR_ALERT_ACTION]),
            sql`${schema.auditLog.data}->>'periodKey' = ${window.periodKey}`,
          ),
        )
        .limit(1);
      if (prior) return { status: "duplicate", emailId: prior.emailId } as const;
      const summary = summarizeSignupRiskDigest(
        await listSignupRiskReviewCandidates(tx, afterLock, cachedPayments),
        window,
      );
      if (!summary.pending) return { status: "empty" } as const;
      // An audit sink sends nothing: the digest becomes one operator.alert row,
      // and its periodKey claim (read above) keeps it to once per period. No
      // sender is needed for a row, only the console link it already carries.
      if (operatorAlertsSink() === "audit") {
        if (!deps.appBaseUrl) throw new Error("signup_risk_digest_console_url_unconfigured");
        const digest = buildSignupRiskDigest(summary, window, deps.appBaseUrl);
        if (!currentWindowOpen(readNow())) return { status: "outside_window" } as const;
        await recordOperatorAlert(tx, {
          kind: SIGNUP_RISK_DIGEST_KIND,
          subject: digest.subject,
          text: digest.text,
          url: digest.url,
          teamId: null,
          periodKey: window.periodKey,
        });
        return { status: "audit_recorded", summary } as const;
      }
      if (!deps.from) throw new Error("signup_risk_digest_sender_unconfigured");
      const owner = await findSenderDomainOwner(tx, deps.from);
      if (!owner) throw new Error("signup_risk_digest_sender_unverified");
      const [senderTeam] = await tx
        .select({ held: schema.teams.sendReviewAt, suspended: schema.teams.suspendedAt })
        .from(schema.teams)
        .where(eq(schema.teams.id, owner.teamId));
      if (!senderTeam || senderTeam.held || senderTeam.suspended)
        throw new Error("signup_risk_digest_sender_restricted");
      if (!deps.appBaseUrl) throw new Error("signup_risk_digest_console_url_unconfigured");
      const message = buildSignupRiskDigest(summary, window, deps.appBaseUrl);
      if (!currentWindowOpen(readNow())) return { status: "outside_window" } as const;
      const accepted = await acceptEmail(
        { db: tx, keyring: deps.keyring, isCloud: deps.isCloud, enqueueEmailSend: async () => {} },
        { teamId: owner.teamId, billing: "uncapped", apiKeyId: null },
        {
          from: deps.from,
          to: [SIGNUP_RISK_DIGEST_RECIPIENT],
          domainId: owner.domainId,
          ...message,
          tags: { [SYSTEM_MAIL_TAG]: SIGNUP_RISK_DIGEST_KIND },
        },
        {
          tx,
          // Encryption/KMS can also wait across 09h. Roll back the tentative row
          // before commit rather than admitting it with a stale pre-accept clock.
          completeInTx: async () => {
            if (!currentWindowOpen(readNow())) throw new SignupRiskDigestWindowClosed();
          },
        },
      );
      if (!accepted.ok) throw new Error(`signup_risk_digest_pipeline_refused:${accepted.reason}`);
      const acceptedAt = readNow();
      if (!currentWindowOpen(acceptedAt)) throw new SignupRiskDigestWindowClosed();
      await tx.insert(schema.teamNotifications).values({
        teamId: owner.teamId,
        kind: SIGNUP_RISK_DIGEST_KIND,
        periodKey: window.periodKey,
        sentAt: acceptedAt,
      });
      await tx.insert(schema.auditLog).values({
        teamId: owner.teamId,
        actorId: "system:signup-risk-digest",
        action: ACCEPTED_ACTION,
        target: `email:${accepted.id}`,
        data: {
          periodKey: window.periodKey,
          emailId: accepted.id,
          timezone: SIGNUP_RISK_DIGEST_TIME_ZONE,
          pending: summary.pending,
          paidAffected: summary.paidAffected,
          paymentUnconfirmed: summary.paymentUnconfirmed,
          newSandbox: summary.newSandbox,
          newHolds: summary.newHolds,
          reviewRequests: summary.reviewRequests,
          newReviewRequests: summary.newReviewRequests,
        },
        createdAt: acceptedAt,
      });
      if (!currentWindowOpen(readNow())) throw new SignupRiskDigestWindowClosed();
      return { status: "pipeline_accepted", emailId: accepted.id, summary } as const;
    })
    .catch((error: unknown) => {
      if (error instanceof SignupRiskDigestWindowClosed)
        return { status: "outside_window" } as const;
      throw error;
    });
  if (result.status !== "pipeline_accepted") return result;
  // A committed email is retried by sends.reconcile if enqueue fails; recreating
  // the digest would duplicate it. No raw provider fallback is allowed here.
  let queued = false;
  try {
    await deps.enqueueSend(result.emailId, undefined, EMAIL_SEND_PRIORITY.transactional);
    queued = true;
  } catch {
    console.error(
      "signup-risk.digest: pipeline accepted; email.send enqueue awaits reconciliation",
    );
  }
  return { ...result, queued };
}
