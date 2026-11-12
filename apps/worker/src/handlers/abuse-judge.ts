import {
  type AbuseJudge,
  applyJudgedSample,
  buildJudgeBlock,
  decryptEmailBody,
  holdOnContentVerdict,
  type JudgeBlockInput,
  judgeErrorClass,
  type Keyring,
  type MonitorSettings,
  openAttachments,
  teamMonitorRow,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import type { SystemMailer } from "../system-mail.js";
import { flushMonitorAlerts } from "./monitor-alerts.js";

export interface JudgeDeps {
  /** Null when the monitor is off: every sample is recorded unjudged. */
  judge: AbuseJudge | null;
  keyring: Keyring;
  settings: () => Promise<MonitorSettings>;
  timeoutMs?: number | undefined;
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  now?: (() => Date) | undefined;
}

/** A throttled call is retried this many times through the queue's backoff before the sample gives up. */
export const JUDGE_THROTTLE_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

export type JudgeOutcome = "judged" | "unjudged" | "skipped";

const ms = schema.monitorSamples;

/**
 * Judge one pending sample. The block is built in memory from the stored
 * body and discarded with the call; the row keeps the verdict fields only.
 * A judge failure of any class records the sample unjudged and changes
 * nothing else; only a throttle is retried, and only a few times. Database
 * and decrypt errors throw so pg-boss retries the job.
 */
export async function judgeSample(
  db: Db,
  deps: JudgeDeps,
  payload: { sampleId: string },
): Promise<JudgeOutcome> {
  const now = deps.now?.() ?? new Date();
  const [sample] = await db.select().from(ms).where(eq(ms.id, payload.sampleId));
  if (sample?.status !== "pending") {
    if (sample?.status === "judged") await flushMonitorAlerts(db, deps, sample.teamId);
    return "skipped";
  }
  const unjudged = async (errorClass: string, latencyMs?: number) => {
    await db
      .update(ms)
      .set({
        status: "unjudged",
        errorClass,
        model: deps.judge?.model ?? null,
        latencyMs: latencyMs ?? null,
        judgedAt: now,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")));
    console.warn(`abuse.judge: sample ${sample.id} unjudged (${errorClass})`);
    return "unjudged" as const;
  };
  if (!deps.judge) return unjudged("off");

  const input = await loadBlockInput(db, deps.keyring, sample, now);
  if (!input) return unjudged("body_purged");
  const block = buildJudgeBlock(input);
  const started = Date.now();
  let verdict: Awaited<ReturnType<AbuseJudge["judge"]>>;
  try {
    verdict = await deps.judge.judge(block, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      onTelemetry: (event) => {
        console.info("abuse.judge.phase", {
          sampleId: sample.id,
          phase: event.phase,
          elapsedMs: event.elapsedMs,
          ...(event.headersMs === undefined ? {} : { headersMs: event.headersMs }),
          ...(event.bodyMs === undefined ? {} : { bodyMs: event.bodyMs }),
          ...(event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus }),
          ...(event.errorClass === undefined ? {} : { errorClass: event.errorClass }),
        });
      },
    });
  } catch (err) {
    const errorClass = judgeErrorClass(err);
    const latencyMs = Date.now() - started;
    if (errorClass === "throttled" && sample.attempts < JUDGE_THROTTLE_RETRIES) {
      await db
        .update(ms)
        .set({ attempts: sample.attempts + 1 })
        .where(eq(ms.id, sample.id));
      throw err;
    }
    return unjudged(errorClass, latencyMs);
  }
  const latencyMs = Date.now() - started;
  const settings = await deps.settings();
  const model = deps.judge.model;
  // The verdict and its fold commit together: a crash between them would
  // leave a judged row the retry skips and a risk that never saw it.
  const outcome = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [judged] = await t
      .update(ms)
      .set({
        status: "judged",
        score: verdict.score,
        verdict: verdict.verdict,
        categories: verdict.categories,
        reasons: verdict.reasons,
        impersonatedBrand: verdict.impersonatedBrand,
        language: verdict.language,
        model,
        latencyMs,
        judgedAt: now,
      })
      .where(and(eq(ms.id, sample.id), eq(ms.status, "pending")))
      .returning({ id: ms.id });
    // A concurrent run already wrote this sample: its verdict stands, the risk moved once.
    if (!judged) return null;
    const folded = await applyJudgedSample(t, settings, {
      teamId: sample.teamId,
      score: verdict.score,
      now,
    });
    await holdOnContentVerdict(t, {
      teamId: sample.teamId,
      score: verdict.score,
      categories: verdict.categories,
      now,
    });
    return folded;
  });
  if (!outcome) return "skipped";
  await flushMonitorAlerts(db, deps, sample.teamId);
  return "judged";
}

/** The judge's input for a sample: the email's decrypted body, or the broadcast's own HTML for a skeleton. */
async function loadBlockInput(
  db: Db,
  keyring: Keyring,
  sample: typeof schema.monitorSamples.$inferSelect,
  now: Date,
): Promise<JudgeBlockInput | null> {
  const [team] = await db
    .select({ name: schema.teams.name, plan: schema.teams.plan })
    .from(schema.teams)
    .where(eq(schema.teams.id, sample.teamId));
  if (!team || team.plan === "system") return null;
  const domains = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, sample.teamId), eq(schema.domains.status, "verified")));
  const monitor = await teamMonitorRow(db, sample.teamId);
  const context: JudgeBlockInput["team"] = {
    name: team.name,
    verifiedDomains: domains.map((d) => d.name),
    ageDays: monitor.firstSendAt
      ? Math.floor((now.getTime() - monitor.firstSendAt.getTime()) / DAY_MS)
      : null,
    plan: team.plan as string,
  };
  if (sample.kind === "broadcast_skeleton") {
    if (!sample.broadcastId || sample.emailId) return null;
    const [broadcast] = await db
      .select({
        from: schema.broadcasts.from,
        replyTo: schema.broadcasts.replyTo,
        subject: schema.broadcasts.subject,
        html: schema.broadcasts.html,
        text: schema.broadcasts.text,
      })
      .from(schema.broadcasts)
      .where(
        and(
          eq(schema.broadcasts.id, sample.broadcastId),
          eq(schema.broadcasts.teamId, sample.teamId),
        ),
      );
    if (!broadcast) return null;
    return {
      team: context,
      from: broadcast.from,
      replyTo: broadcast.replyTo ? (JSON.parse(broadcast.replyTo) as string[]) : null,
      subject: broadcast.subject,
      html: broadcast.html,
      text: broadcast.text,
      attachments: [],
    };
  }
  if (
    !sample.emailId ||
    (sample.kind === "broadcast_copy" ? !sample.broadcastId : sample.broadcastId !== null)
  )
    return null;
  if (sample.kind === "broadcast_copy") {
    const [broadcast] = await db
      .select({ id: schema.broadcasts.id })
      .from(schema.broadcasts)
      .where(
        and(
          eq(schema.broadcasts.id, sample.broadcastId as string),
          eq(schema.broadcasts.teamId, sample.teamId),
        ),
      );
    if (!broadcast) return null;
  }
  const [email] = await db
    .select()
    .from(schema.emails)
    .where(and(eq(schema.emails.id, sample.emailId), eq(schema.emails.teamId, sample.teamId)));
  if (
    !email ||
    email.broadcastId !== sample.broadcastId ||
    email.bodyPurgedAt ||
    !email.bodyCiphertext ||
    !email.bodyIv ||
    !email.bodyWrappedDek ||
    email.bodyKeyVersion === null
  ) {
    return null;
  }
  const owner = { teamId: email.teamId, rowId: email.id };
  const body = await decryptEmailBody(
    {
      ciphertext: email.bodyCiphertext,
      iv: email.bodyIv,
      wrappedDek: email.bodyWrappedDek,
      keyVersion: email.bodyKeyVersion,
    },
    keyring,
    owner,
  );
  const attachments = email.attachments
    ? (await openAttachments(email.attachments, keyring, owner)).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
      }))
    : [];
  return {
    team: context,
    from: email.from,
    replyTo: email.replyTo,
    subject: email.subject,
    html: body.html,
    text: body.text,
    attachments,
  };
}
