"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Select } from "@/components/select";
import { toast } from "@/components/toast";
import {
  type MailboxRuleMatchKind,
  normalizeRuleValue,
  ruleCovers,
  senderDomain,
  validRuleValue,
} from "@/lib/mailbox-rules-match";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailbox-rules.module.css";
import shell from "./mailboxes.module.css";

type Outputs = inferRouterOutputs<AppRouter>;
export type MailboxRule = Outputs["mailboxRules"]["list"][number];
type SearchRow = Outputs["mailboxes"]["search"]["items"][number];
type MatchKind = MailboxRuleMatchKind;
type Destination = "none" | "folder" | "archive" | "box";

/** A mailbox the person owns: the only kind a rule lives in or sends mail to. */
export type MailboxRuleBox = { id: string; label: string; address: string };

/** "Aplicar às que já estão na Entrada" looks at this many search pages of 50. */
const EXISTING_PAGES = 10;
const SEARCH_PAGE = 50;
/** Messages one setSeenMany call takes (server: MAILBOX_SEEN_BATCH). */
const SEEN_BATCH = 200;
/** A list this long shows a page at a time, with a search on top. */
const PAGE = 50;
const SEARCH_FROM = 8;

function errorCode(error: unknown): string | null {
  return error instanceof TRPCClientError
    ? ((error.data?.code as string | undefined) ?? null)
    : null;
}

async function runLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await work(item);
      }
    }),
  );
}

/**
 * Criar / editar uma regra automática: mail from a sender or a domain goes to a folder
 * of this mailbox, to the Archive or to another mailbox the person owns, read and/or
 * starred if they like. Opened from a message (`from`: sender or its domain, prefilled),
 * from Preferências (blank) or on an existing rule. Rules apply to the next messages; the
 * box below also organizes what is in the Inbox now, with the moves the list already has.
 */
export function MailboxRuleDialog({
  mailboxId,
  boxes,
  rule,
  from,
  close,
  saved,
}: {
  mailboxId: string;
  /** The mailboxes this person owns (the rule's own one included). */
  boxes: MailboxRuleBox[];
  /** Editing this rule; otherwise a new one. */
  rule?: MailboxRule | null;
  /** A new rule for this sender (the open message's From). */
  from?: string | null;
  close: () => void;
  saved?: (rule: MailboxRule) => void;
}) {
  const t = useTranslations("mailboxes-rules");
  const common = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const seededFrom = rule ? null : (from?.trim().toLowerCase() ?? null);
  const fromDomain = seededFrom ? senderDomain(seededFrom) : "";
  const [kind, setKind] = useState<MatchKind>(rule?.match.kind ?? "sender");
  const [value, setValue] = useState(rule?.match.value ?? seededFrom ?? "");
  const [destination, setDestination] = useState<Destination>(
    rule?.targetMailboxId
      ? "box"
      : rule?.archive
        ? "archive"
        : rule?.folderId
          ? "folder"
          : rule
            ? "none"
            : "folder",
  );
  const [folderId, setFolderId] = useState(rule?.folderId ?? "");
  const [targetId, setTargetId] = useState(rule?.targetMailboxId ?? "");
  const [markRead, setMarkRead] = useState(rule ? rule.markRead : true);
  const [star, setStar] = useState(rule?.star ?? false);
  const [applyExisting, setApplyExisting] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [existing, setExisting] = useState<
    | { state: "idle" }
    | { state: "counting" }
    | { state: "done"; key: string; rows: SearchRow[]; more: boolean }
    | { state: "error" }
  >({ state: "idle" });

  const folders = useQuery(
    trpc.mailboxes.folders.queryOptions({ mailboxId }, { staleTime: 30_000, retry: 1 }),
  );
  const save = useMutation(trpc.mailboxRules.save.mutationOptions({ retry: false }));
  const folderMove = useMutation(trpc.mailboxes.setItemFolder.mutationOptions({ retry: false }));
  const archiveMove = useMutation(trpc.mailboxes.setArchive.mutationOptions({ retry: false }));
  const starMove = useMutation(trpc.mailboxes.setStar.mutationOptions({ retry: false }));
  const seenMany = useMutation(trpc.mailboxes.setSeenMany.mutationOptions({ retry: false }));
  const busy = save.isPending || progress !== null;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const folderOptions = (folders.data ?? []).filter((folder) => folder.mailboxId === mailboxId);
  const targets = boxes.filter((box) => box.id !== mailboxId);
  // A folder that is gone (archived) is no choice any more; nor is a box no longer theirs.
  useEffect(() => {
    if (folders.data && folderId && !folderOptions.some((folder) => folder.id === folderId))
      setFolderId("");
  }, [folders.data, folderId, folderOptions]);
  useEffect(() => {
    if (targetId && !targets.some((box) => box.id === targetId)) setTargetId("");
  }, [targetId, targets]);

  const normalized = normalizeRuleValue(kind, value);
  const valid = validRuleValue(kind, normalized);
  const matchKey = `${kind}:${normalized}`;
  // What is in the Inbox from this sender now (search's de:, then the exact match here).
  useEffect(() => {
    if (!valid) {
      setExisting({ state: "idle" });
      return;
    }
    let cancelled = false;
    setExisting({ state: "counting" });
    const timer = setTimeout(async () => {
      try {
        const rows: SearchRow[] = [];
        let cursor: string | undefined;
        let more = false;
        for (let page = 0; page < EXISTING_PAGES; page++) {
          const result = await queries.fetchQuery(
            trpc.mailboxes.search.queryOptions(
              {
                query: `de:${normalized}`,
                mailboxId,
                folder: "inbox",
                limit: SEARCH_PAGE,
                ...(cursor ? { cursor } : {}),
              },
              { staleTime: 0, retry: false },
            ),
          );
          for (const row of result.items)
            if (
              row.kind === "inbox" &&
              row.folder === "inbox" &&
              ruleCovers({ kind, value: normalized }, row.from)
            )
              rows.push(row);
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
          if (page === EXISTING_PAGES - 1) more = true;
        }
        if (!cancelled) setExisting({ state: "done", key: matchKey, rows, more });
      } catch {
        if (!cancelled) setExisting({ state: "error" });
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [valid, normalized, kind, matchKey, mailboxId, queries, trpc]);

  const existingRows = existing.state === "done" && existing.key === matchKey ? existing.rows : [];
  const canApplyExisting = destination !== "box" && existingRows.length > 0;

  function message(code: string | null): string {
    if (code === "CONFLICT") return t("limit");
    if (code === "FORBIDDEN") return t("forbidden");
    if (code === "NOT_FOUND") return t("notFound");
    if (code === "BAD_REQUEST") return t("badRequest");
    if (code === "PRECONDITION_FAILED") return t("unavailable");
    return t("error");
  }

  /** The Inbox messages found above, organized as the rule would have. */
  async function organize(rows: SearchRow[]) {
    let done = 0;
    let moved = 0;
    setProgress({ done: 0, total: rows.length });
    await runLimited(rows, 4, async (row) => {
      const ref = { mailboxId: row.mailboxId, id: row.id };
      try {
        let revision = row.revision;
        if (destination === "folder" && folderId && row.folderId !== folderId)
          revision = (
            await folderMove.mutateAsync({ ...ref, expectedRevision: revision, folderId })
          ).revision;
        else if (destination === "archive" && !row.archivedAt)
          revision = (
            await archiveMove.mutateAsync({ ...ref, expectedRevision: revision, archived: true })
          ).revision;
        if (star && !row.starredAt)
          await starMove.mutateAsync({ ...ref, expectedRevision: revision, starred: true });
        moved++;
      } catch {
        // Changed meanwhile (CONFLICT) or gone: left as it is, counted below.
      }
      done++;
      setProgress({ done, total: rows.length });
    });
    const unread = rows.filter((row) => row.seenAt === null);
    if (markRead && unread.length) {
      for (let start = 0; start < unread.length; start += SEEN_BATCH) {
        try {
          await seenMany.mutateAsync({
            items: unread
              .slice(start, start + SEEN_BATCH)
              .map((row) => ({ mailboxId: row.mailboxId, id: row.id })),
            seen: true,
          });
        } catch {
          // The moves stand; read state is the owner's own view and can be redone.
        }
      }
    }
    await Promise.all([
      queries.invalidateQueries({ queryKey: trpc.mailboxes.items.pathKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.search.pathKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.folderCounts.pathKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.unreadCounts.pathKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.item.pathKey() }),
    ]);
    return moved;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!valid) {
      setError(t(kind === "sender" ? "invalidSender" : "invalidDomain"));
      return;
    }
    if (destination === "folder" && !folderId) {
      setError(t("needFolder"));
      return;
    }
    if (destination === "box" && !targetId) {
      setError(t("needBox"));
      return;
    }
    if (destination === "none" && !markRead && !star) {
      setError(t("needAction"));
      return;
    }
    let result: MailboxRule;
    try {
      result = await save.mutateAsync({
        mailboxId,
        ...(rule ? { id: rule.id } : {}),
        match: { kind, value: normalized },
        folderId: destination === "folder" ? folderId : null,
        archive: destination === "archive",
        markRead,
        star,
        targetMailboxId: destination === "box" ? targetId : null,
      });
    } catch (cause) {
      setError(message(errorCode(cause)));
      return;
    }
    void queries.invalidateQueries({ queryKey: trpc.mailboxRules.list.queryKey({ mailboxId }) });
    const match =
      result.match.kind === "domain"
        ? t("anyFrom", { domain: result.match.value })
        : result.match.value;
    if (applyExisting && canApplyExisting) {
      const rows = existingRows;
      const moved = await organize(rows);
      toast(
        moved === rows.length
          ? t("savedApplied", { count: moved })
          : t("savedPartial", { done: moved, total: rows.length }),
        moved === rows.length ? "success" : "info",
      );
    } else {
      toast(t("saved", { match }), "success");
    }
    saved?.(result);
    close();
  }

  const destinations: { value: Destination; label: string; disabled?: boolean }[] = [
    { value: "folder", label: t("destFolder") },
    { value: "archive", label: t("destArchive") },
    { value: "box", label: t("destBox"), disabled: !targets.length },
    { value: "none", label: t("destNone") },
  ];

  return (
    <dialog
      ref={dialog}
      className={shell.dialog}
      aria-labelledby={`${id}-title`}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={shell.dialogHeader}>
        <h2 id={`${id}-title`}>{t(rule ? "titleEdit" : "titleNew")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={common("close")}
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <p className={styles.help}>{t("help")}</p>
        {boxes.length > 1 ? (
          <p className={styles.box}>
            {t("mailbox")}: <strong>{boxes.find((box) => box.id === mailboxId)?.address}</strong>
          </p>
        ) : null}

        <fieldset className={styles.group} disabled={busy}>
          <legend>{t("when")}</legend>
          {seededFrom && fromDomain ? (
            <div className={styles.choices}>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-match`}
                  checked={kind === "sender"}
                  onChange={() => {
                    setKind("sender");
                    setValue(seededFrom);
                  }}
                />
                <span>
                  {t("matchSender")} <strong>{seededFrom}</strong>
                </span>
              </label>
              <label className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-match`}
                  checked={kind === "domain"}
                  onChange={() => {
                    setKind("domain");
                    setValue(fromDomain);
                  }}
                />
                <span>
                  {t("matchDomain", { domain: fromDomain })}
                  <small>{t("matchDomainHint", { domain: fromDomain })}</small>
                </span>
              </label>
            </div>
          ) : (
            <>
              <div className={shell.kind}>
                {(["sender", "domain"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={kind === option}
                    onClick={() => {
                      setKind(option);
                      setError("");
                      // An address typed under Endereço keeps its domain under Domínio.
                      if (option === "domain" && value.includes("@")) setValue(senderDomain(value));
                    }}
                  >
                    {t(option === "sender" ? "kindSender" : "kindDomain")}
                  </button>
                ))}
              </div>
              <input
                className="ms-input"
                type={kind === "sender" ? "email" : "text"}
                aria-label={t(kind === "sender" ? "valueSender" : "valueDomain")}
                placeholder={t(kind === "sender" ? "placeholderSender" : "placeholderDomain")}
                value={value}
                maxLength={320}
                autoComplete="off"
                spellCheck={false}
                autoFocus={!rule}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (error) setError("");
                }}
              />
              {kind === "domain" && valid ? (
                <small className={styles.help}>
                  {t("matchDomainHint", { domain: normalized })}
                </small>
              ) : null}
            </>
          )}
        </fieldset>

        <fieldset className={styles.group} disabled={busy}>
          <legend>{t("action")}</legend>
          <div className={styles.choices}>
            {destinations.map((option) => (
              <label key={option.value} className={styles.choice}>
                <input
                  type="radio"
                  name={`${id}-destination`}
                  checked={destination === option.value}
                  disabled={option.disabled}
                  onChange={() => {
                    setDestination(option.value);
                    setError("");
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {destination === "folder" ? (
            folders.data && !folderOptions.length ? (
              <p className={styles.help}>{t("noFolders")}</p>
            ) : (
              <div className={styles.picker}>
                <Select
                  id={`${id}-folder`}
                  ariaLabel={t("folder")}
                  value={folderId}
                  width="100%"
                  disabled={!folders.data}
                  onChange={(next) => {
                    setFolderId(next);
                    setError("");
                  }}
                  options={[
                    { value: "", label: t("folder"), disabled: true },
                    ...folderOptions.map((folder) => ({ value: folder.id, label: folder.name })),
                  ]}
                />
              </div>
            )
          ) : null}
          {destination === "box" ? (
            targets.length ? (
              <div className={styles.picker}>
                <Select
                  id={`${id}-box`}
                  ariaLabel={t("targetBox")}
                  value={targetId}
                  width="100%"
                  onChange={(next) => {
                    setTargetId(next);
                    setError("");
                  }}
                  options={[
                    { value: "", label: t("targetBox"), disabled: true },
                    ...targets.map((box) => ({
                      value: box.id,
                      label: `${box.label} · ${box.address}`,
                    })),
                  ]}
                />
              </div>
            ) : (
              <p className={styles.help}>{t("noBoxes")}</p>
            )
          ) : null}
          <div className={styles.flags}>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={markRead}
                onChange={(event) => setMarkRead(event.target.checked)}
              />
              <span>{t("markRead")}</span>
            </label>
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={star}
                onChange={(event) => setStar(event.target.checked)}
              />
              <span>{t("star")}</span>
            </label>
          </div>
        </fieldset>

        {valid ? (
          <div className={styles.existing} aria-live="polite">
            {destination === "box" ? (
              <p className={styles.help}>{t("existingBox")}</p>
            ) : existing.state === "counting" ? (
              <p className={styles.help}>{t("existingCounting")}</p>
            ) : existing.state === "done" && existing.key === matchKey ? (
              existingRows.length ? (
                <label className={styles.choice}>
                  <input
                    type="checkbox"
                    checked={applyExisting}
                    disabled={busy}
                    onChange={(event) => setApplyExisting(event.target.checked)}
                  />
                  <span>
                    {t("applyExisting")}
                    <small>
                      {existing.more
                        ? t("existingMore", { count: existingRows.length })
                        : t("existingCount", { count: existingRows.length })}
                    </small>
                  </span>
                </label>
              ) : (
                <p className={styles.help}>{t("existingCount", { count: 0 })}</p>
              )
            ) : null}
          </div>
        ) : null}

        {progress ? (
          <p className={styles.help} role="status">
            {t("applying", progress)}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className={shell.error}>
            {error}
          </p>
        ) : null}
        <footer className={shell.dialogFooter}>
          <button type="button" className="ms-btn" disabled={busy} onClick={close}>
            {common("cancel")}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={busy}>
            {common(busy ? "saving" : "save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** A rule's match as a person reads it. */
function useMatchLabel() {
  const t = useTranslations("mailboxes-rules");
  return (match: MailboxRule["match"]) =>
    match.kind === "domain" ? t("anyFrom", { domain: match.value }) : match.value;
}

/**
 * Preferências → "Regras automáticas": the rules of each mailbox the person owns, newest
 * first, each one editable and removable (with Desfazer), and a new one from scratch.
 */
export function MailboxRules({
  boxes,
  preferredId,
}: {
  /** The mailboxes this person owns (only an owner keeps rules for a mailbox). */
  boxes: MailboxRuleBox[];
  /** The mailbox open in the inbox, shown first when it is one of them. */
  preferredId?: string | null;
}) {
  const t = useTranslations("mailboxes-rules");
  const id = useId();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const matchLabel = useMatchLabel();
  const [mailboxId, setMailboxId] = useState(
    () => boxes.find((box) => box.id === preferredId)?.id ?? boxes[0]?.id ?? "",
  );
  const [editing, setEditing] = useState<MailboxRule | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!boxes.some((box) => box.id === mailboxId)) setMailboxId(boxes[0]?.id ?? "");
  }, [boxes, mailboxId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on mailbox change only.
  useEffect(() => {
    setQuery("");
    setShown(PAGE);
  }, [mailboxId]);

  const list = useQuery(
    trpc.mailboxRules.list.queryOptions(
      { mailboxId },
      { enabled: !!mailboxId, staleTime: 30_000, retry: 1 },
    ),
  );
  const folders = useQuery(
    trpc.mailboxes.folders.queryOptions(
      { mailboxId },
      { enabled: !!mailboxId, staleTime: 30_000, retry: 1 },
    ),
  );
  const save = useMutation(trpc.mailboxRules.save.mutationOptions({ retry: false }));
  const remove = useMutation(trpc.mailboxRules.delete.mutationOptions({ retry: false }));

  if (!boxes.length) return null;

  const rules = list.data ?? [];
  const folded = query.trim().toLowerCase();
  const matching = folded ? rules.filter((rule) => rule.match.value.includes(folded)) : rules;
  const folderName = (folderId: string) =>
    folders.data?.find((folder) => folder.id === folderId)?.name ?? null;
  const boxLabel = (boxId: string) => {
    const box = boxes.find((candidate) => candidate.id === boxId);
    return box ? box.address : null;
  };

  async function restore(rule: MailboxRule) {
    try {
      await save.mutateAsync({
        mailboxId,
        match: rule.match,
        folderId: rule.folderMissing ? null : rule.folderId,
        archive: rule.archive,
        markRead: rule.markRead,
        star: rule.star,
        targetMailboxId: rule.targetUnavailable ? null : rule.targetMailboxId,
      });
    } catch {
      toast(t("error"), "danger");
    }
    await list.refetch();
  }

  async function drop(rule: MailboxRule) {
    setBusy(rule.id);
    try {
      await remove.mutateAsync({ mailboxId, id: rule.id });
    } catch {
      toast(t("deleteError"), "danger");
      return;
    } finally {
      setBusy(null);
    }
    await list.refetch();
    toast(t("deleted", { match: matchLabel(rule.match) }), "success", {
      action: { label: t("undo"), run: () => void restore(rule) },
    });
  }

  function summary(rule: MailboxRule): { text: string; warning: string | null } {
    const parts: string[] = [];
    let warning: string | null = null;
    if (rule.targetMailboxId) {
      const label = boxLabel(rule.targetMailboxId);
      if (label && !rule.targetUnavailable) parts.push(t("toBox", { box: label }));
      else warning = t("boxMissing");
    } else if (rule.archive) parts.push(t("toArchive"));
    else if (rule.folderId && !rule.folderMissing) {
      parts.push(t("toFolder", { folder: folderName(rule.folderId) ?? "…" }));
    } else if (rule.folderMissing) warning = t("folderMissing");
    else parts.push(t("toInbox"));
    if (rule.markRead) parts.push(t("flagRead"));
    if (rule.star) parts.push(t("flagStar"));
    return { text: parts.join(" · "), warning };
  }

  return (
    <div className={styles.rules}>
      {boxes.length > 1 ? (
        <div className={styles.rulesBox}>
          <label htmlFor={`${id}-box`}>{t("mailbox")}</label>
          <Select
            id={`${id}-box`}
            ariaLabel={t("mailbox")}
            value={mailboxId}
            width={280}
            onChange={setMailboxId}
            options={boxes.map((box) => ({
              value: box.id,
              label: `${box.label} · ${box.address}`,
            }))}
          />
        </div>
      ) : (
        <p className={styles.help}>{boxes[0]?.address}</p>
      )}
      <p className={styles.help}>{t("listHint")}</p>
      <div className={styles.rulesTools}>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={!mailboxId}
          onClick={() => setEditing("new")}
        >
          + {t("add")}
        </button>
        {rules.length >= SEARCH_FROM ? (
          <input
            type="search"
            className="ms-input"
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShown(PAGE);
            }}
          />
        ) : null}
      </div>

      {list.isError ? (
        <p className={styles.help} role="alert">
          {t("loadError")}{" "}
          <button type="button" className="ms-btn ms-btn-ghost" onClick={() => void list.refetch()}>
            {t("retry")}
          </button>
        </p>
      ) : list.isPending ? (
        <p className={styles.help}>{t("loading")}</p>
      ) : !rules.length ? (
        <p className={styles.help}>{t("empty")}</p>
      ) : !matching.length ? (
        <p className={styles.help}>{t("noMatch")}</p>
      ) : (
        <ul className={styles.list}>
          {matching.slice(0, shown).map((rule) => {
            const label = matchLabel(rule.match);
            const { text, warning } = summary(rule);
            return (
              <li key={rule.id}>
                <div className={styles.ruleText}>
                  <span className={styles.match}>{label}</span>
                  <span className={styles.summary}>
                    {text}
                    {warning ? (
                      <span className={styles.warning}>
                        {text ? " · " : ""}
                        {warning}
                      </span>
                    ) : null}
                  </span>
                </div>
                <button
                  type="button"
                  className={`ms-btn ms-btn-ghost ${styles.rowAction}`}
                  disabled={busy === rule.id}
                  aria-label={t("editLabel", { match: label })}
                  onClick={() => setEditing(rule)}
                >
                  {t("edit")}
                </button>
                <button
                  type="button"
                  className="ms-btn ms-btn-ghost"
                  disabled={busy === rule.id}
                  aria-label={t("delete", { match: label })}
                  title={t("delete", { match: label })}
                  onClick={() => void drop(rule)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {matching.length > shown ? (
        <button
          type="button"
          className={`ms-btn ms-btn-ghost ${styles.showMore}`}
          onClick={() => setShown((value) => value + PAGE)}
        >
          {t("showMore", { count: matching.length - shown })}
        </button>
      ) : null}

      {editing ? (
        <MailboxRuleDialog
          mailboxId={mailboxId}
          boxes={boxes}
          rule={editing === "new" ? null : editing}
          close={() => setEditing(null)}
          saved={() =>
            void queries.invalidateQueries({
              queryKey: trpc.mailboxRules.list.queryKey({ mailboxId }),
            })
          }
        />
      ) : null}
    </div>
  );
}
