import { MAILBOX_FOLDER_NAME_MAX, normalizeMailboxFolderName } from "./mailbox-move";

/**
 * Trazer o histórico: bringing an old account's messages over IMAP
 * (mailboxes.migration.import*). The server reads each chosen folder with
 * the password held in memory only; each folder lands in the Inbox, Sent,
 * Archive or a named folder of the target mailbox.
 */
export type ImportTarget = "inbox" | "sent" | "archive" | "folder";

export type ImportFolderChoice = {
  /** The remote folder (raw name or LIST display). */
  name: string;
  display: string;
  target: ImportTarget;
};

export type ImportJobState = "running" | "done" | "failed" | "interrupted" | "canceled";
export type ImportJobError =
  | "login"
  | "network"
  | "protocol"
  | "blocked"
  | "quota"
  | "not_entitled"
  | "canceled";

export type ImportJob = {
  jobId: string;
  mailboxId: string;
  host: string;
  username: string;
  state: ImportJobState;
  error: ImportJobError | null;
  imported: number;
  skipped: number;
  failed: number;
  bytes: number;
  folders: {
    name: string;
    target: ImportTarget;
    total: number;
    imported: number;
    skipped: number;
    failed: number;
  }[];
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
};

const LEAF = (name: string) => name.split(/[/.]/).pop()?.trim().toLowerCase() ?? "";

/**
 * Where a remote folder goes when the server has not said (it reads the
 * folder flags; this reads the name). Null: not offered (trash, spam,
 * drafts).
 */
export function suggestImportTarget(display: string): ImportTarget | null {
  const full = display.trim().toLowerCase();
  const leaf = LEAF(display);
  if (full === "inbox" || full === "caixa de entrada") return "inbox";
  if (
    /^(trash|lixeira|lixo|deleted( items| messages)?|itens excluídos|excluídos|junk( e-?mail)?|spam|lixo eletrônico|bulk mail|drafts|rascunhos)$/.test(
      leaf,
    )
  )
    return null;
  if (
    /^(sent( items| messages| mail)?|enviados|enviadas|itens enviados|e-mails enviados)$/.test(leaf)
  )
    return "sent";
  if (/^(archive|archives|arquivo|arquivos|all mail|todos os e-mails)$/.test(leaf))
    return "archive";
  return "folder";
}

/** The Correio folder a remote folder becomes: its path, readable, within the name rules. */
export function importFolderName(display: string): string {
  const readable = display
    .split(/\//)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
  return normalizeMailboxFolderName(
    Array.from(readable).slice(0, MAILBOX_FOLDER_NAME_MAX).join(""),
  );
}

/** The choices a connected account starts with: every offered folder at its suggested place. */
export function defaultImportChoices(
  folders: readonly string[],
  targets?: readonly { name: string; display: string; target: ImportTarget }[],
): ImportFolderChoice[] {
  if (targets?.length) return targets.map((entry) => ({ ...entry }));
  return folders.flatMap((display) => {
    const target = suggestImportTarget(display);
    return target ? [{ name: display, display, target }] : [];
  });
}

/** Done out of total across folders (0 to 1), or null while totals are unknown. */
export function importProgress(job: Pick<ImportJob, "folders">): number | null {
  const total = job.folders.reduce((sum, folder) => sum + folder.total, 0);
  if (!total) return null;
  const done = job.folders.reduce(
    (sum, folder) => sum + folder.imported + folder.skipped + folder.failed,
    0,
  );
  return Math.min(1, done / total);
}

/** An import still bringing mail in: new-mail notices stay quiet meanwhile. */
export function importRunning(jobs: readonly Pick<ImportJob, "state">[] | undefined): boolean {
  return !!jobs?.some((job) => job.state === "running");
}
