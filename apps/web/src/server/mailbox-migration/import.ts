import { createHash } from "node:crypto";
import {
  importMailboxMime,
  type Keyring,
  MailboxContentError,
  MailboxServiceError,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq } from "drizzle-orm";
import {
  ImapError,
  type ImapFolder,
  type ImapImportSession,
  type ImapOpenDeps,
  openImap,
} from "./imap";

/**
 * History import from another provider over IMAP into one Correio mailbox.
 *
 * The person types the account's password; it lives only in this process while
 * the job runs and is never written anywhere. Each folder's UIDVALIDITY and the
 * last UID imported are saved after every batch, so a job that a restart or a
 * network error stopped resumes where it was once the password is typed again.
 * The remote account is only read (EXAMINE and BODY.PEEK): nothing is marked
 * read, moved or deleted there. Every message is imported once: its source id is
 * a hash of the account, folder, UIDVALIDITY and UID.
 */

export type ImportTarget = "inbox" | "sent" | "archive" | "folder";
export type ImportFailure =
  | "login"
  | "network"
  | "protocol"
  | "blocked"
  | "quota"
  | "not_entitled"
  | "canceled";
export type MailboxImportFolder = (typeof schema.mailboxImportJobs.$inferSelect)["folders"][number];
type Job = typeof schema.mailboxImportJobs.$inferSelect;
type Actor = { teamId: string; userId: string };

export class MailboxImportError extends Error {
  constructor(
    public readonly code:
      | "login"
      | "network"
      | "blocked"
      | "busy"
      | "not_found"
      | "invalid"
      | "running",
  ) {
    super(code);
  }
}

/** Where a remote folder's mail goes by default; null = not offered (Trash, Junk, Drafts…). */
export function importTarget(folder: ImapFolder): ImportTarget | null {
  const flags = new Set(folder.flags);
  if (
    flags.has("\\noselect") ||
    flags.has("\\trash") ||
    flags.has("\\junk") ||
    flags.has("\\drafts")
  )
    return null;
  if (flags.has("\\sent")) return "sent";
  if (flags.has("\\archive") || flags.has("\\all")) return "archive";
  if (folder.name.toUpperCase() === "INBOX") return "inbox";
  return "folder";
}

/** A batch: at most this many messages and about this many bytes per UID FETCH. */
const BATCH_MESSAGES = 25;
const BATCH_BYTES = 20 * 1024 * 1024;
/** Received mail is admitted up to this size; larger messages are counted as failed. */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

interface Live {
  password: string;
  cancel: boolean;
}
/** Running jobs of this process, with the password they need. Nothing else holds it. */
const live = new Map<string, Live>();

export interface ImportDeps extends ImapOpenDeps {
  open?: (
    input: { host: string; port: number; username: string; password: string },
    deps: ImapOpenDeps,
  ) => Promise<ImapImportSession>;
  importItem?: typeof importMailboxMime;
  /** Tests await the background run. */
  onSettled?: (jobId: string) => void;
}

function sourceId(
  job: Pick<Job, "host" | "username">,
  folder: string,
  validity: number,
  uid: number,
) {
  const key = createHash("sha256")
    .update(`${job.host.toLowerCase()}|${job.username.toLowerCase()}|${folder}|${validity}|${uid}`)
    .digest("hex")
    .slice(0, 32);
  return `imap:${key}`;
}

function failureOf(error: unknown): ImportFailure {
  if (error instanceof ImapError) return error.reason;
  if (error instanceof MailboxServiceError)
    return error.code === "quota" ? "quota" : "not_entitled";
  return "network";
}

async function ownJob(db: Db, actor: Actor, jobId: string) {
  const [job] = await db
    .select()
    .from(schema.mailboxImportJobs)
    .where(
      and(
        eq(schema.mailboxImportJobs.id, jobId),
        eq(schema.mailboxImportJobs.teamId, actor.teamId),
        eq(schema.mailboxImportJobs.createdBy, actor.userId),
      ),
    );
  if (!job) throw new MailboxImportError("not_found");
  // A job this process does not run any more stopped with it: it resumes with the password.
  if (job.state === "running" && !live.has(job.id)) {
    const [stopped] = await db
      .update(schema.mailboxImportJobs)
      .set({ state: "interrupted", updatedAt: new Date() })
      .where(
        and(eq(schema.mailboxImportJobs.id, job.id), eq(schema.mailboxImportJobs.state, "running")),
      )
      .returning();
    return stopped ?? job;
  }
  return job;
}

export function importJobView(job: Job) {
  return {
    jobId: job.id,
    mailboxId: job.mailboxId,
    host: job.host,
    username: job.username,
    state: job.state,
    error: job.error,
    imported: job.imported,
    skipped: job.skipped,
    failed: job.failed,
    bytes: job.bytes,
    folders: job.folders.map((f) => ({
      name: f.display,
      target: f.target,
      total: f.total,
      imported: f.imported,
      skipped: f.skipped,
      failed: f.failed,
    })),
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export interface ImportStartInput {
  host: string;
  port: number;
  username: string;
  password: string;
  mailboxId: string;
  folders: { name: string; target: ImportTarget; folderId?: string | null | undefined }[];
}

/**
 * Checks the login and the chosen folders, saves the job and starts it in the
 * background. The owner of the mailbox starts it; the import itself goes through
 * importMailboxMime, which enforces ownership, the plan and the storage.
 */
export async function startMailboxImport(
  db: Db,
  keys: Keyring,
  actor: Actor,
  input: ImportStartInput,
  deps: ImportDeps = {},
) {
  if (!input.folders.length || input.folders.length > 50) throw new MailboxImportError("invalid");
  const [box] = await db
    .select({ id: schema.mailboxes.id, ownerUserId: schema.mailboxes.ownerUserId })
    .from(schema.mailboxes)
    .where(
      and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, actor.teamId)),
    );
  if (!box || box.ownerUserId !== actor.userId) throw new MailboxImportError("not_found");
  for (const choice of input.folders) {
    if (choice.target !== "folder") continue;
    if (!choice.folderId) throw new MailboxImportError("invalid");
    const [folder] = await db
      .select({ id: schema.mailboxFolders.id })
      .from(schema.mailboxFolders)
      .where(
        and(
          eq(schema.mailboxFolders.id, choice.folderId),
          eq(schema.mailboxFolders.mailboxId, input.mailboxId),
          eq(schema.mailboxFolders.teamId, actor.teamId),
        ),
      );
    if (!folder) throw new MailboxImportError("invalid");
  }
  let session: ImapImportSession;
  try {
    session = await (deps.open ?? openImap)(input, { ...deps, maxLiteralBytes: MAX_MESSAGE_BYTES });
  } catch (error) {
    const reason = error instanceof ImapError ? error.reason : "network";
    throw new MailboxImportError(
      reason === "login" ? "login" : reason === "blocked" ? "blocked" : "network",
    );
  }
  let remote: ImapFolder[];
  try {
    remote = await session.list();
  } finally {
    await session.logout();
  }
  const folders: MailboxImportFolder[] = [];
  for (const choice of input.folders) {
    const found = remote.find((f) => f.name === choice.name || f.display === choice.name);
    if (!found || importTarget(found) === null) throw new MailboxImportError("invalid");
    if (folders.some((f) => f.name === found.name)) continue;
    folders.push({
      name: found.name,
      display: found.display,
      target: choice.target,
      folderId: choice.target === "folder" ? (choice.folderId ?? null) : null,
      uidValidity: null,
      lastUid: 0,
      total: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
    });
  }
  let job: Job | undefined;
  try {
    [job] = await db
      .insert(schema.mailboxImportJobs)
      .values({
        teamId: actor.teamId,
        mailboxId: input.mailboxId,
        createdBy: actor.userId,
        host: input.host.trim().toLowerCase(),
        port: input.port,
        username: input.username.trim(),
        folders,
      })
      .returning();
  } catch {
    // The partial unique index allows one running import per mailbox.
    throw new MailboxImportError("running");
  }
  if (!job) throw new MailboxImportError("running");
  launch(db, keys, actor, job, input.password, deps);
  return importJobView(job);
}

/** Resumes an interrupted or failed import with the password, from the saved positions. */
export async function resumeMailboxImport(
  db: Db,
  keys: Keyring,
  actor: Actor,
  input: { jobId: string; password: string },
  deps: ImportDeps = {},
) {
  const job = await ownJob(db, actor, input.jobId);
  if (job.state === "running") throw new MailboxImportError("running");
  if (job.state === "done" || job.state === "canceled") throw new MailboxImportError("invalid");
  const [resumed] = await db
    .update(schema.mailboxImportJobs)
    .set({ state: "running", error: null, finishedAt: null, updatedAt: new Date() })
    .where(
      and(eq(schema.mailboxImportJobs.id, job.id), eq(schema.mailboxImportJobs.state, job.state)),
    )
    .returning()
    .catch(() => []);
  if (!resumed) throw new MailboxImportError("running");
  launch(db, keys, actor, resumed, input.password, deps);
  return importJobView(resumed);
}

export async function cancelMailboxImport(db: Db, actor: Actor, jobId: string) {
  const job = await ownJob(db, actor, jobId);
  const running = live.get(job.id);
  if (running) running.cancel = true;
  if (job.state === "running" || job.state === "interrupted" || job.state === "failed") {
    const [canceled] = await db
      .update(schema.mailboxImportJobs)
      .set({ state: "canceled", error: "canceled", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.mailboxImportJobs.id, job.id))
      .returning();
    return importJobView(canceled ?? job);
  }
  return importJobView(job);
}

export async function mailboxImportStatus(db: Db, actor: Actor, jobId: string) {
  return importJobView(await ownJob(db, actor, jobId));
}

/** The person's imports into one mailbox, or into all of them (null), newest first. */
export async function listMailboxImports(db: Db, actor: Actor, mailboxId: string | null) {
  const jobs = await db
    .select({ id: schema.mailboxImportJobs.id })
    .from(schema.mailboxImportJobs)
    .where(
      and(
        mailboxId === null ? undefined : eq(schema.mailboxImportJobs.mailboxId, mailboxId),
        eq(schema.mailboxImportJobs.teamId, actor.teamId),
        eq(schema.mailboxImportJobs.createdBy, actor.userId),
      ),
    )
    .orderBy(desc(schema.mailboxImportJobs.startedAt))
    .limit(20);
  return Promise.all(jobs.map((job) => mailboxImportStatus(db, actor, job.id)));
}

function launch(db: Db, keys: Keyring, actor: Actor, job: Job, password: string, deps: ImportDeps) {
  const state: Live = { password, cancel: false };
  live.set(job.id, state);
  void runImport(db, keys, actor, job, state, deps).finally(() => {
    // The password goes with the run; a resume needs it typed again.
    state.password = "";
    live.delete(job.id);
    deps.onSettled?.(job.id);
  });
}

async function save(db: Db, job: Job, patch: Partial<Job>) {
  await db
    .update(schema.mailboxImportJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(schema.mailboxImportJobs.id, job.id), eq(schema.mailboxImportJobs.state, "running")),
    );
}

async function runImport(
  db: Db,
  keys: Keyring,
  actor: Actor,
  job: Job,
  state: Live,
  deps: ImportDeps,
) {
  const importItem = deps.importItem ?? importMailboxMime;
  const folders = job.folders.map((f) => ({ ...f }));
  const totals = {
    imported: job.imported,
    skipped: job.skipped,
    failed: job.failed,
    bytes: job.bytes,
  };
  let session: ImapImportSession | null = null;
  try {
    session = await (deps.open ?? openImap)(
      { host: job.host, port: job.port, username: job.username, password: state.password },
      { ...deps, maxLiteralBytes: MAX_MESSAGE_BYTES },
    );
    for (const folder of folders) {
      if (state.cancel) break;
      const examined = await session.examine(folder.name);
      const validity = examined.uidValidity ?? 0;
      // A new UIDVALIDITY renumbers the folder: start it over (source ids keep it idempotent).
      if (folder.uidValidity !== validity) {
        folder.uidValidity = validity;
        folder.lastUid = 0;
      }
      const uids = await session.uidSearchAfter(folder.lastUid);
      folder.total = folder.imported + folder.skipped + folder.failed + uids.length;
      await save(db, job, { folders });
      const sizes = await session.uidFetchSizes(uids);
      for (let start = 0; start < uids.length && !state.cancel; ) {
        const batch: number[] = [];
        let bytes = 0;
        while (start < uids.length && batch.length < BATCH_MESSAGES) {
          const uid = uids[start]!;
          const size = sizes.get(uid) ?? 0;
          if (size > MAX_MESSAGE_BYTES) {
            // Too large to receive here either: counted, not fetched.
            folder.failed += 1;
            totals.failed += 1;
            folder.lastUid = uid;
            start += 1;
            continue;
          }
          if (batch.length && bytes + size > BATCH_BYTES) break;
          batch.push(uid);
          bytes += size;
          start += 1;
        }
        if (!batch.length) continue;
        for (const message of await session.uidFetchMessages(batch)) {
          try {
            await importItem(db, keys, actor, {
              mailboxId: job.mailboxId,
              sourceId: sourceId(job, folder.name, validity, message.uid),
              raw: message.raw,
              history: {
                kind: folder.target === "sent" ? "sent" : "inbox",
                receivedAt: message.internalDate ?? new Date(),
                seen: folder.target === "sent" || message.flags.includes("\\seen"),
                archived: folder.target === "archive",
                folderId: folder.target === "folder" ? folder.folderId : null,
              },
            });
            folder.imported += 1;
            totals.imported += 1;
            totals.bytes += message.raw.length;
          } catch (error) {
            if (error instanceof MailboxServiceError) throw error;
            // Malformed or not admitted: counted, the import goes on.
            if (error instanceof MailboxContentError && error.code === "conflict") {
              folder.skipped += 1;
              totals.skipped += 1;
            } else {
              folder.failed += 1;
              totals.failed += 1;
            }
          }
          folder.lastUid = Math.max(folder.lastUid, message.uid);
        }
        folder.lastUid = Math.max(folder.lastUid, batch.at(-1)!);
        await save(db, job, { folders, ...totals });
      }
    }
    if (!state.cancel)
      await save(db, job, { folders, ...totals, state: "done", finishedAt: new Date() });
  } catch (error) {
    if (!state.cancel)
      await save(db, job, {
        folders,
        ...totals,
        state: error instanceof ImapError && error.reason === "network" ? "interrupted" : "failed",
        error: failureOf(error),
        finishedAt: new Date(),
      });
  } finally {
    await session?.logout().catch(() => undefined);
  }
}

/** Test hook: forget the running jobs of this process. */
export function resetMailboxImports() {
  live.clear();
}
