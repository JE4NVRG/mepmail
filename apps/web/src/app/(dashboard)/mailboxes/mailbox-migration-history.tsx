"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import {
  defaultImportChoices,
  type ImportFolderChoice,
  type ImportJob,
  type ImportTarget,
  importFolderName,
  importProgress,
} from "@/lib/mailbox-import";
import type { MigrationSource, TeamMailbox } from "@/lib/mailbox-migration";
import type { MigrationApi } from "@/lib/mailbox-migration-api";
import { MAILBOX_FOLDERS_MAX } from "@/lib/mailbox-move";
import { useTRPCClient } from "@/lib/trpc";
import styles from "./mailbox-migration.module.css";

const TARGETS: ImportTarget[] = ["inbox", "sent", "archive", "folder"];
const MAX_FOLDERS_PER_JOB = 50;
const START_ERRORS = new Set(["login", "network", "blocked", "invalid", "running", "not_found"]);

type StartError =
  | "login"
  | "network"
  | "blocked"
  | "invalid"
  | "running"
  | "not_found"
  | "folders"
  | "generic";

function startFailure(cause: unknown): StartError {
  const message = cause instanceof Error ? cause.message : "";
  return START_ERRORS.has(message) ? (message as StartError) : "generic";
}

/**
 * Trazer o histórico, the assistant's last step: the old account's folders
 * land in one Correio mailbox (Inbox, Sent, Archive or a named folder made
 * for them). The password is typed again here and lives only in the server's
 * memory while the import runs; a dropped connection asks for it again.
 */
export function MailboxMigrationHistory({
  api,
  host,
  username,
  source,
  mailboxes,
  currentUserId,
  onBack,
}: {
  api: MigrationApi;
  host: string;
  username: string;
  source: MigrationSource | null;
  mailboxes: TeamMailbox[];
  currentUserId: string;
  onBack: () => void;
}) {
  const t = useTranslations("mailboxes.migration.history");
  const format = useFormatter();
  const client = useTRPCClient();
  const id = useId();
  const owned = useMemo(
    () => mailboxes.filter((box) => box.ownerUserId === currentUserId),
    [mailboxes, currentUserId],
  );
  const [mailboxId, setMailboxId] = useState(
    () =>
      owned.find((box) => box.address.toLowerCase() === username.trim().toLowerCase())?.id ??
      owned[0]?.id ??
      "",
  );
  const [choices, setChoices] = useState<ImportFolderChoice[]>(() =>
    defaultImportChoices(source?.folders ?? [], source?.folderTargets),
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(choices.slice(0, MAX_FOLDERS_PER_JOB).map((choice) => choice.name)),
  );
  const [password, setPassword] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<StartError | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  // An import of this account already under way (or stopped) picks up where it is.
  const jobs = useQuery({
    queryKey: ["mailbox-import", "jobs", mailboxId],
    queryFn: () => api.importJobs(mailboxId || null),
    enabled: !!mailboxId && jobId === null,
  });
  const resumable = jobs.data?.find(
    (job) =>
      job.host === host.trim().toLowerCase() &&
      job.username.toLowerCase() === username.trim().toLowerCase() &&
      job.state !== "done" &&
      job.state !== "canceled",
  );
  const currentId = jobId ?? resumable?.jobId ?? null;
  const job = useQuery({
    queryKey: ["mailbox-import", "job", currentId],
    queryFn: () => api.importStatus(currentId as string),
    enabled: currentId !== null,
    refetchInterval: (query) => (query.state.data?.state === "running" ? 2000 : false),
  });
  const current: ImportJob | undefined = job.data ?? resumable;

  const selected = choices.filter((choice) => chosen.has(choice.name));
  const displayOf = new Map(choices.map((choice) => [choice.name, choice.display]));
  const tooMany = selected.length > MAX_FOLDERS_PER_JOB;
  const canStart =
    !!mailboxId && selected.length > 0 && !tooMany && password.length > 0 && !starting;

  function retarget(name: string, target: ImportTarget) {
    setChoices((list) =>
      list.map((choice) => (choice.name === name ? { ...choice, target } : choice)),
    );
  }
  function toggle(name: string, on: boolean) {
    setChosen((set) => {
      const next = new Set(set);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  /** Named folders: an existing one with the same name (any case) is reused. */
  async function folderIds(): Promise<Map<string, string>> {
    const wanted = selected.filter((choice) => choice.target === "folder");
    const ids = new Map<string, string>();
    if (!wanted.length) return ids;
    const existing = await client.mailboxes.folders.query({ mailboxId });
    const byName = new Map(existing.map((folder) => [folder.name.toLowerCase(), folder.id]));
    if (
      byName.size +
        new Set(
          wanted
            .map((choice) => importFolderName(choice.display).toLowerCase())
            .filter((name) => !byName.has(name)),
        ).size >
      MAILBOX_FOLDERS_MAX
    )
      throw new Error("folders");
    for (const choice of wanted) {
      const name = importFolderName(choice.display);
      let folderId = byName.get(name.toLowerCase());
      if (!folderId) {
        folderId = (await client.mailboxes.createFolder.mutate({ mailboxId, name })).id;
        byName.set(name.toLowerCase(), folderId);
      }
      ids.set(choice.name, folderId);
    }
    return ids;
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (!canStart) return;
    setStarting(true);
    setStartError(null);
    try {
      const ids = await folderIds();
      const started = await api.importStart({
        host: host.trim(),
        port: 993,
        username: username.trim(),
        password,
        mailboxId,
        folders: selected.map((choice) => ({
          name: choice.name,
          target: choice.target,
          ...(choice.target === "folder" ? { folderId: ids.get(choice.name) ?? null } : {}),
        })),
      });
      setPassword("");
      setJobId(started.jobId);
    } catch (cause) {
      setStartError(
        cause instanceof Error && cause.message === "folders" ? "folders" : startFailure(cause),
      );
    } finally {
      setStarting(false);
    }
  }

  async function resume(event: React.FormEvent) {
    event.preventDefault();
    if (!current || !password) return;
    setStarting(true);
    setStartError(null);
    try {
      const resumed = await api.importResume(current.jobId, password);
      setPassword("");
      setJobId(resumed.jobId);
      await job.refetch();
    } catch (cause) {
      setStartError(startFailure(cause));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!current) return;
    try {
      await api.importCancel(current.jobId);
    } finally {
      await job.refetch();
    }
  }

  const passwordField = (
    <label htmlFor={`${id}-password`}>
      {t("password", { username })}
      <input
        id={`${id}-password`}
        className="ms-input"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <small>{t("passwordHint")}</small>
    </label>
  );
  const errorNotice = startError ? (
    <p role="alert" className={styles.groupNotice}>
      {t(`errors.${startError}`)}
    </p>
  ) : null;

  if (current) {
    const progress = importProgress(current);
    const stopped = current.state === "interrupted" || current.state === "failed";
    return (
      <>
        <div>
          <h4>{t("title")}</h4>
          <p className="ms-meta-tall">
            {t(`state.${current.state}`, {
              imported: current.imported,
              size: format.number(current.bytes / 1024 / 1024, { maximumFractionDigits: 1 }),
            })}
          </p>
          {current.error ? (
            <p role="alert" className={styles.groupNotice}>
              {t(`jobErrors.${current.error}`)}
            </p>
          ) : null}
        </div>
        <div className={styles.progress}>
          <progress
            aria-label={t("title")}
            value={progress ?? undefined}
            max={progress === null ? undefined : 1}
          />
          <span>
            {progress === null
              ? t("counting")
              : t("percent", { value: format.number(progress, { style: "percent" }) })}
          </span>
        </div>
        <ul className={styles.importFolders}>
          {current.folders.map((folder) => (
            <li key={folder.name}>
              <span className={styles.importFolderName}>
                {displayOf.get(folder.name) ?? folder.name}
              </span>
              <span>{t(`target.${folder.target}`)}</span>
              <span>
                {t("folderCount", { imported: folder.imported, total: folder.total })}
                {folder.failed ? ` · ${t("failedCount", { count: folder.failed })}` : ""}
              </span>
            </li>
          ))}
        </ul>
        {stopped ? (
          <form className={styles.form} onSubmit={resume}>
            <div className={styles.fields}>{passwordField}</div>
            {errorNotice}
            <div className={styles.actions}>
              <button className="ms-btn ms-btn-ghost" type="button" onClick={() => void cancel()}>
                {t("cancel")}
              </button>
              <button
                className="ms-btn ms-btn-primary"
                type="submit"
                disabled={!password || starting}
              >
                {t(starting ? "resuming" : "resume")}
              </button>
            </div>
          </form>
        ) : (
          <div className={styles.actions}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={onBack}>
              {t("back")}
            </button>
            {current.state === "running" ? (
              <button type="button" className="ms-btn" onClick={() => void cancel()}>
                {t("cancel")}
              </button>
            ) : (
              <button
                type="button"
                className="ms-btn"
                onClick={() => {
                  setJobId(null);
                  void jobs.refetch();
                }}
              >
                {t("another")}
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <form className={styles.form} onSubmit={start}>
      <div>
        <h4>{t("title")}</h4>
        <p className="ms-meta-tall">{t("hint", { host, username })}</p>
      </div>
      {!owned.length ? (
        <p className={styles.groupNotice}>{t("noMailbox")}</p>
      ) : (
        <>
          <div className={styles.fields}>
            <label htmlFor={`${id}-mailbox`}>
              {t("mailbox")}
              <select
                id={`${id}-mailbox`}
                className="ms-input"
                value={mailboxId}
                onChange={(event) => setMailboxId(event.target.value)}
              >
                {owned.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.label} · {box.address}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {choices.length ? (
            <fieldset className={styles.importChoices}>
              <legend>{t("folders", { count: selected.length })}</legend>
              <ul className={styles.importFolders}>
                {choices.map((choice) => (
                  <li key={choice.name} data-selected={chosen.has(choice.name)}>
                    <label className={styles.importFolderName}>
                      <input
                        type="checkbox"
                        checked={chosen.has(choice.name)}
                        onChange={(event) => toggle(choice.name, event.target.checked)}
                      />
                      <span>{choice.display}</span>
                    </label>
                    <select
                      className="ms-input"
                      aria-label={t("targetFor", { folder: choice.display })}
                      value={choice.target}
                      disabled={!chosen.has(choice.name)}
                      onChange={(event) =>
                        retarget(choice.name, event.target.value as ImportTarget)
                      }
                    >
                      {TARGETS.map((target) => (
                        <option key={target} value={target}>
                          {target === "folder"
                            ? t("targetFolder", { name: importFolderName(choice.display) })
                            : t(`target.${target}`)}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
              {tooMany ? (
                <p className={styles.groupNotice}>{t("tooMany", { max: MAX_FOLDERS_PER_JOB })}</p>
              ) : null}
            </fieldset>
          ) : (
            <p className={styles.groupNotice}>{t("noFolders")}</p>
          )}
          <div className={styles.fields}>{passwordField}</div>
          {errorNotice}
        </>
      )}
      <div className={styles.actions}>
        <button type="button" className="ms-btn ms-btn-ghost" onClick={onBack}>
          {t("back")}
        </button>
        <button type="submit" className="ms-btn ms-btn-primary" disabled={!canStart}>
          {t(starting ? "starting" : "start")}
        </button>
      </div>
    </form>
  );
}
