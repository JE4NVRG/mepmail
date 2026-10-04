"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NavGlyph } from "@/components/icons/nav-icons";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailboxes.module.css";

type Outputs = inferRouterOutputs<AppRouter>["mailboxes"];
type Box = Outputs["list"]["mailboxes"][number];
type Item = Outputs["item"];
type Folder = "inbox" | "drafts" | "sent";
type ComposeMode = "reply" | "forward";
type SendState = "requesting" | Outputs["queueDraft"]["status"];
const NIL = "00000000-0000-0000-0000-000000000000";
function attachmentUrl(
  item: { mailboxId: string; id: string; revision: number },
  index: number,
  preview = false,
) {
  return `/api/mailboxes/${item.mailboxId}/items/${item.id}/attachments/${index}?revision=${item.revision}${preview ? "&preview=1" : ""}`;
}
function Attachment({ item, attachment }: { item: Item; attachment: Item["attachments"][number] }) {
  const t = useTranslations("mailboxes");
  const [failed, fail] = useState(false);
  return (
    <figure className={styles.attachment}>
      {attachment.image && !failed ? (
        <a
          href={attachmentUrl(item, attachment.index, true)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("openImage", { name: attachment.filename })}
        >
          {/* Private authenticated bytes: original route is bounded and never proxies external images. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={attachmentUrl(item, attachment.index, true)}
            alt={attachment.filename}
            loading="lazy"
            width={attachment.image.width}
            height={attachment.image.height}
            onError={() => fail(true)}
          />
        </a>
      ) : (
        <NavGlyph name="emails" hovered={false} />
      )}
      <figcaption>
        <span>
          <span title={attachment.filename}>{attachment.filename}</span>
          <small>{Math.ceil(attachment.bytes / 1024)} KB</small>
        </span>
        <a
          className="ms-btn ms-btn-ghost"
          aria-label={t("downloadFile", { name: attachment.filename })}
          href={attachmentUrl(item, attachment.index)}
          download
        >
          {t("download")}
        </a>
      </figcaption>
    </figure>
  );
}

function DraftDialog({
  boxes,
  mailboxId,
  source,
  mode,
  deliveryReady,
  close,
  saved,
  lost,
  selectBox,
  current,
}: {
  boxes: Box[];
  mailboxId: string;
  source: Item | null;
  mode: ComposeMode;
  deliveryReady: boolean;
  close: () => void;
  saved: (item: Outputs["saveDraft"]) => Promise<void>;
  lost: () => void;
  selectBox: (id: string) => void;
  current: () => boolean;
}) {
  const t = useTranslations("mailboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const dialog = useRef<HTMLDialogElement>(null);
  const boxId = mailboxId;
  const [to, setTo] = useState(
    source
      ? source.kind === "draft"
        ? source.to.join(", ")
        : mode === "forward"
          ? ""
          : source.replyTo
      : "",
  );
  const [subject, setSubject] = useState(
    source
      ? source.kind === "draft"
        ? source.subject
        : mode === "forward"
          ? /^fw(?:d)?:/i.test(source.subject)
            ? source.subject
            : `Fw: ${source.subject}`
          : /^re:/i.test(source.subject)
            ? source.subject
            : `Re: ${source.subject}`
      : "",
  );
  const [text, setText] = useState(
    source?.kind === "draft"
      ? source.text
      : source && mode === "forward"
        ? t("forwardedBody", {
            sender: source.fromName ? `${source.fromName} <${source.from}>` : source.from,
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(source.date ?? source.updatedAt),
            recipients: source.to.join(", "),
            subject: source.subject,
            text: source.text
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n"),
          })
        : "",
  );
  const [retained, setRetained] = useState(source?.attachments.map((a) => a.index) ?? []);
  const [uploads, setUploads] = useState<{ id: number; filename: string; base64: string }[]>([]);
  const uploadSequence = useRef(0);
  const [loadingFiles, loadFiles] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const active = useRef(true);
  const [error, setError] = useState("");
  const mutation = useMutation(trpc.mailboxes.saveDraft.mutationOptions());
  const busy = saving || mutation.isPending || loadingFiles;
  useEffect(() => {
    active.current = true;
    dialog.current?.showModal();
    return () => {
      active.current = false;
    };
  }, []);
  const allowed = boxes.some(
    (b) => b.id === boxId && b.canRead && b.canDraft && b.status === "planned",
  );
  useEffect(() => {
    if (!allowed) lost();
  }, [allowed, lost]);
  async function addFiles(files: FileList | null) {
    if (!files?.length || submitting.current || !current()) return;
    setError("");
    if (
      retained.length + uploads.length + files.length > 10 ||
      Array.from(files).some((f) => !f.size || f.size > 256 * 1024)
    ) {
      setError(t("attachmentLimit"));
      return;
    }
    loadFiles(true);
    try {
      const incoming = await Promise.all(
        Array.from(files).map(
          (file) =>
            new Promise<{ id: number; filename: string; base64: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () =>
                typeof reader.result === "string"
                  ? resolve({
                      id: ++uploadSequence.current,
                      filename: file.name.slice(0, 160),
                      base64: reader.result.split(",")[1] ?? "",
                    })
                  : reject(new Error("file"));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            }),
        ),
      );
      setUploads((previous) => [...previous, ...incoming]);
    } catch {
      setError(t("attachmentError"));
    } finally {
      loadFiles(false);
    }
  }
  function dismiss() {
    if (!submitting.current && !loadingFiles && current()) close();
  }
  return (
    <dialog
      ref={dialog}
      className={`${styles.dialog} ${styles.composer}`}
      aria-labelledby="draft-title"
      onClose={dismiss}
      onCancel={(e) => {
        if (submitting.current || loadingFiles) e.preventDefault();
      }}
    >
      <header className={styles.dialogHeader}>
        <h2 id="draft-title">
          {t(
            source?.kind === "draft"
              ? "editDraft"
              : source
                ? mode === "forward"
                  ? "forwardDraft"
                  : "replyDraft"
                : "newDraft",
          )}
        </h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={t("close")}
          disabled={busy}
          onClick={dismiss}
        >
          ×
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current || loadingFiles || !allowed || !current()) return;
          submitting.current = true;
          setSaving(true);
          setError("");
          try {
            const result = await mutation.mutateAsync({
              mailboxId: boxId,
              id: source?.kind === "draft" ? source.id : undefined,
              expectedRevision: source?.kind === "draft" ? source.revision : 0,
              sourceItemId: source?.id,
              mode: source?.kind === "draft" ? undefined : mode,
              to: to
                .split(/[,;]/)
                .map((v) => v.trim())
                .filter(Boolean),
              subject,
              text,
              retainedAttachments: retained,
              uploads: uploads.map(({ filename, base64 }) => ({ filename, base64 })),
            });
            if (!active.current || !current()) return;
            await saved(result);
            if (active.current && current()) close();
          } catch (cause) {
            if (!active.current || !current()) return;
            const code = (cause as { data?: { code?: string } })?.data?.code;
            if (code === "FORBIDDEN") {
              lost();
              return;
            }
            setError(
              t(
                code === "CONFLICT"
                  ? "draftConflict"
                  : code === "FORBIDDEN"
                    ? "accessLost"
                    : "draftError",
              ),
            );
          } finally {
            submitting.current = false;
            if (active.current && current()) setSaving(false);
          }
        }}
      >
        <fieldset className={styles.fields} disabled={busy || !allowed}>
          <label>
            {t("from")}
            <select
              className="ms-input"
              value={boxId}
              onChange={(e) => selectBox(e.target.value)}
              disabled={!!source}
            >
              {boxes
                .filter((b) => b.canDraft && b.status === "planned")
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} · {b.address}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {t("to")}
            <input
              className="ms-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="pessoa@dominio.com"
              maxLength={5100}
              autoFocus={mode === "forward"}
            />
          </label>
          <label>
            {t("subject")}
            <input
              className="ms-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={998}
            />
          </label>
          <label>
            {t("message")}
            <textarea
              className="ms-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={262144}
              rows={9}
              autoFocus={mode !== "forward"}
            />
          </label>
          <div className={styles.draftAttachments}>
            {source?.attachments
              .filter((a) => retained.includes(a.index))
              .map((a) => (
                <div key={a.index}>
                  <span>{a.filename}</span>
                  <button
                    type="button"
                    className="ms-btn ms-btn-ghost"
                    aria-label={t("removeAttachment", { name: a.filename })}
                    onClick={() => setRetained((v) => v.filter((i) => i !== a.index))}
                  >
                    ×
                  </button>
                </div>
              ))}
            {uploads.map((a) => (
              <div key={a.id}>
                <span>{a.filename}</span>
                <button
                  type="button"
                  className="ms-btn ms-btn-ghost"
                  aria-label={t("removeAttachment", { name: a.filename })}
                  onClick={() => setUploads((v) => v.filter((upload) => upload.id !== a.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <label>
            {t("attach")}
            <input
              type="file"
              multiple
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <small className={styles.hint}>{t("attachmentLimit")}</small>
          </label>
        </fieldset>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <p className={styles.hint}>{t(deliveryReady ? "draftSaveFirst" : "draftOnly")}</p>
        <footer className={styles.dialogFooter}>
          <button type="button" className="ms-btn" disabled={busy} onClick={dismiss}>
            {t("cancel")}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={busy}>
            {t(busy ? "saving" : "saveDraft")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function MailboxContentView({
  navigation,
  boxes,
  selected,
  folder,
  manage,
  changeFolder,
  selection,
  select,
  draftSaved,
}: {
  navigation: ReactNode;
  boxes: Box[];
  selected: Box | null;
  folder: Folder;
  manage?: (() => void) | undefined;
  changeFolder: (folder: Folder) => void;
  selection: { mailboxId: string; id: string } | null;
  select: (item: { mailboxId: string; id: string } | null) => void;
  draftSaved: (item: Outputs["saveDraft"]) => void;
}) {
  const t = useTranslations("mailboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const capability = useQuery(trpc.mailboxes.capabilities.queryOptions());
  const sendMutation = useMutation(trpc.mailboxes.queueDraft.mutationOptions({ retry: false }));
  const [search, setSearch] = useState("");
  const [composer, compose] = useState<{
    session: number;
    mailboxId: string;
    source: Item | null;
    mode: ComposeMode;
  } | null>(null);
  const composerSequence = useRef(0);
  const composerSession = useRef<number | null>(null);
  const [notice, setNotice] = useState("");
  const sending = useRef<string | null>(null);
  const attempted = useRef(new Set<string>());
  const [sendStates, setSendStates] = useState<Record<string, SendState>>({});
  const mounted = useRef(true);
  const reader = useRef<HTMLElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const listing = useQuery(
    trpc.mailboxes.items.queryOptions(
      { mailboxId: selected?.id ?? null, folder },
      { retry: false, gcTime: 0, refetchInterval: 15000 },
    ),
  );
  const readable = boxes.filter((b) => b.canRead && b.status === "planned");
  const rows =
    listing.data?.items.filter((i) =>
      `${i.subject} ${i.from} ${i.fromName} ${i.to.join(" ")} ${i.snippet} ${i.address}`
        .toLowerCase()
        .includes(search.toLowerCase().trim()),
    ) ?? [];
  const selectedBox = readable.find((b) => b.id === selection?.mailboxId);
  const visibleItem =
    !listing.isError &&
    selectedBox &&
    rows.some((i) => i.id === selection?.id && i.mailboxId === selection?.mailboxId)
      ? selection
      : null;
  const detail = useQuery(
    trpc.mailboxes.item.queryOptions(visibleItem ?? { mailboxId: NIL, id: NIL }, {
      enabled: !!visibleItem,
      retry: false,
      gcTime: 0,
      refetchInterval: 15000,
    }),
  );
  const item = visibleItem && !detail.isError ? detail.data : null;
  const pendingSentReply = item?.kind === "sent" && !item.transportMessageId;
  const writable = boxes.filter((b) => b.canDraft && b.status === "planned");
  const denied = [listing.error, detail.error].some(
    (cause) => (cause as { data?: { code?: string } } | null)?.data?.code === "FORBIDDEN",
  );
  const composerAllowed = !!composer && writable.some((b) => b.id === composer.mailboxId);
  function openComposer(mailboxId: string, source: Item | null, mode: ComposeMode = "reply") {
    const session = ++composerSequence.current;
    composerSession.current = session;
    compose({ session, mailboxId, source, mode });
  }
  const closeComposer = useCallback((session: number) => {
    if (composerSession.current !== session) return;
    composerSession.current = null;
    compose(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      composerSession.current = null;
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (denied) void queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
  }, [denied, queries, trpc]);
  useEffect(() => {
    if (composer && !composerAllowed) {
      closeComposer(composer.session);
      setNotice(t("accessLost"));
    }
  }, [closeComposer, composer, composerAllowed, t]);
  useEffect(() => {
    if (visibleItem) {
      reader.current?.focus({ preventScroll: true });
      if (reader.current) reader.current.scrollTop = 0;
    }
  }, [visibleItem]);
  function backToList() {
    const previous = selection;
    select(null);
    if (previous)
      requestAnimationFrame(() =>
        rowButtons.current
          .get(`${previous.mailboxId}:${previous.id}`)
          ?.focus({ preventScroll: true }),
      );
  }
  const date = (value: Date) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
  async function refresh() {
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.items.queryKey() });
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.item.queryKey() });
  }
  const sendKey = item ? `${item.mailboxId}:${item.id}:${item.revision}` : null;
  const sendState = item?.sendStatus ?? (sendKey ? sendStates[sendKey] : undefined);
  const deliveryReady = capability.data?.deliveryReady === true;
  const canSubmitDraft =
    item?.kind === "draft" && selectedBox?.canSend === true && deliveryReady && !sendState;
  async function submitDraft() {
    if (!item || !sendKey || !canSubmitDraft || sending.current || attempted.current.has(sendKey))
      return;
    // Capture the displayed revision once. Never retry an uncertain submission,
    // and never substitute a newly selected message while this request is pending.
    const revision = { mailboxId: item.mailboxId, id: item.id, expectedRevision: item.revision };
    const key = sendKey;
    sending.current = key;
    attempted.current.add(key);
    setSendStates((states) => ({ ...states, [key]: "requesting" }));
    setNotice("");
    try {
      const result = await sendMutation.mutateAsync(revision);
      if (!mounted.current) return;
      setSendStates((states) => ({ ...states, [key]: result.status }));
      setNotice(
        t(
          result.status === "unknown"
            ? "sendUnknown"
            : result.status === "failed"
              ? "sendFailed"
              : result.status === "accepted"
                ? "sendAccepted"
                : result.status === "sending"
                  ? "sendProcessing"
                  : "sendQueued",
        ),
      );
    } catch (cause) {
      if (!mounted.current) return;
      const code = (cause as { data?: { code?: string } })?.data?.code;
      setSendStates((states) => ({ ...states, [key]: "unknown" }));
      setNotice(t(code === "FORBIDDEN" ? "accessLost" : "sendUnknown"));
      if (code === "FORBIDDEN")
        void queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
    } finally {
      sending.current = null;
      if (mounted.current) void refresh();
    }
  }
  const hasRows = !listing.isError && !listing.isPending && rows.length > 0;
  const shortDate = (value: Date) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(value);
  const canCompose = writable.length > 0 && (!selected || selected.canDraft);
  const newDraft = () => openComposer(selected?.id ?? writable[0]!.id, null);
  return (
    <>
      <div className={styles.contentWorkspace}>
        <section className={styles.contentToolbar} aria-label={t("mailControls")}>
          {notice ? (
            <p role="alert" className={styles.contentNotice}>
              {notice}
            </p>
          ) : null}
          {navigation}
          <div className={styles.contentActions}>
            {manage ? (
              <button type="button" className="ms-btn ms-btn-ghost" onClick={manage}>
                {t("manage")}
              </button>
            ) : null}
            {canCompose && folder !== "sent" ? (
              <button type="button" className="ms-btn ms-btn-primary" onClick={newDraft}>
                <span aria-hidden="true">✎</span> {t("compose")}
              </button>
            ) : null}
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-label={t("refresh")}
              disabled={listing.isFetching}
              onClick={() => void refresh()}
            >
              ↻
            </button>
          </div>
        </section>
        <div className={styles.contentPanels} data-empty={!hasRows}>
          <div className={`${styles.list} ${styles.contentList}`} data-reading={!!visibleItem}>
            <div className={styles.listSearch}>
              <div className={styles.searchField}>
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <path d="m16 16 4.5 4.5" />
                </svg>
                <input
                  className="ms-input"
                  aria-label={t("searchMessages")}
                  placeholder={t("searchMessages")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {!listing.isPending && !listing.isError ? (
                <span className={styles.messageCount}>
                  {t("messageCount", { count: rows.length })}
                </span>
              ) : null}
            </div>
            <div className={styles.listBody}>
              {listing.isError ? (
                <div role="alert" className={styles.emptyFolder}>
                  <p>{t("contentError")}</p>
                  <button type="button" className="ms-btn" onClick={() => void listing.refetch()}>
                    {t("retry")}
                  </button>
                </div>
              ) : listing.isPending ? (
                <p className={styles.emptyFolder} aria-live="polite">
                  {t("loading")}
                </p>
              ) : rows.length ? (
                <div className={styles.messageRows}>
                  {rows.map((row) => (
                    <button
                      type="button"
                      key={`${row.mailboxId}:${row.id}`}
                      ref={(button) => {
                        const key = `${row.mailboxId}:${row.id}`;
                        if (button) rowButtons.current.set(key, button);
                        else rowButtons.current.delete(key);
                      }}
                      aria-pressed={
                        selection?.id === row.id && selection?.mailboxId === row.mailboxId
                      }
                      onClick={() => select({ mailboxId: row.mailboxId, id: row.id })}
                    >
                      <div className={styles.rowMeta}>
                        <span>
                          {row.kind === "draft"
                            ? row.to.join(", ") || t("noRecipient")
                            : row.fromName || row.from}
                        </span>
                        <time title={date(row.date)} dateTime={row.date.toISOString()}>
                          {shortDate(row.date)}
                        </time>
                      </div>
                      <strong>{row.subject || t("noSubject")}</strong>
                      <p>{row.snippet}</p>
                      <div className={styles.rowBottom}>
                        {!selected ? <small title={row.address}>{row.address}</small> : <span />}
                        {row.attachmentCount ? (
                          <small>{t("attachmentsCount", { count: row.attachmentCount })}</small>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.emptyFolder}>
                  <NavGlyph name="emails" hovered={false} />
                  <h3>
                    {t(
                      search
                        ? "noMessageMatches"
                        : folder === "sent"
                          ? "sentEmptyTitle"
                          : folder === "drafts"
                            ? "draftsEmptyTitle"
                            : "inboxEmptyTitle",
                    )}
                  </h3>
                  <p>
                    {t(
                      search
                        ? "searchEmptyBody"
                        : folder === "sent"
                          ? "sentEmptyBody"
                          : folder === "drafts"
                            ? "draftsEmptyBody"
                            : "inboxEmptyBody",
                    )}
                  </p>
                  {search ? (
                    <button type="button" className="ms-btn" onClick={() => setSearch("")}>
                      {t("clearSearch")}
                    </button>
                  ) : folder === "sent" ? (
                    <button type="button" className="ms-btn" onClick={() => changeFolder("drafts")}>
                      {t("viewDrafts")}
                    </button>
                  ) : canCompose ? (
                    <button type="button" className="ms-btn" onClick={newDraft}>
                      {t("newDraft")}
                    </button>
                  ) : null}
                </div>
              )}
              {listing.data?.limited && !listing.isError ? (
                <p className={styles.notice}>{t("listLimit")}</p>
              ) : null}
            </div>
          </div>
          {hasRows ? (
            <section
              ref={reader}
              aria-label={t("readingPane")}
              tabIndex={-1}
              className={`${styles.detail} ${styles.contentDetail}`}
              data-reading={!!visibleItem}
            >
              <div className={styles.detailTop}>
                <button
                  type="button"
                  className={`ms-btn ms-btn-ghost ${styles.mobileBack}`}
                  onClick={backToList}
                >
                  ← {t("back")}
                </button>
                <span title={selectedBox?.address ?? selected?.address}>
                  {selectedBox?.address ?? selected?.address ?? t("all")}
                </span>
                {item && selectedBox?.canDraft ? (
                  <div className={styles.contentActions}>
                    <button
                      type="button"
                      className="ms-btn"
                      disabled={
                        pendingSentReply ||
                        !!(item.kind === "draft" && sendState && sendState !== "failed")
                      }
                      aria-describedby={pendingSentReply ? "mailbox-sent-reply-pending" : undefined}
                      onClick={() => openComposer(item.mailboxId, item)}
                    >
                      {t(item.kind === "draft" ? "editDraft" : "replyDraft")}
                    </button>
                    {item.kind !== "draft" ? (
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost"
                        onClick={() => openComposer(item.mailboxId, item, "forward")}
                      >
                        {t("forward")}
                      </button>
                    ) : selectedBox.canSend && deliveryReady ? (
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary"
                        disabled={!canSubmitDraft || sendMutation.isPending}
                        onClick={() => void submitDraft()}
                      >
                        {t(sendState === "requesting" ? "sending" : "send")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {detail.isError && visibleItem ? (
                <div role="alert" className={styles.emptyFolder}>
                  <p>{t("accessLost")}</p>
                  <button
                    type="button"
                    className="ms-btn"
                    onClick={() => {
                      select(null);
                      void refresh();
                    }}
                  >
                    {t("refresh")}
                  </button>
                </div>
              ) : visibleItem && detail.isPending ? (
                <p className={styles.emptyFolder} aria-live="polite">
                  {t("loading")}
                </p>
              ) : item ? (
                <article className={styles.message}>
                  <header>
                    <h2>{item.subject || t("noSubject")}</h2>
                    <div className={styles.senderDetails}>
                      <span className={styles.senderAvatar} aria-hidden="true">
                        {(item.fromName || item.from || "M").charAt(0).toUpperCase()}
                      </span>
                      <dl>
                        <div>
                          <dt>{t("from")}</dt>
                          <dd>
                            {item.fromName ? `${item.fromName} · ` : ""}
                            {item.from}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("to")}</dt>
                          <dd>{item.to.join(", ") || t("noRecipient")}</dd>
                        </div>
                      </dl>
                    </div>
                    <small>{date(item.date ?? item.updatedAt)}</small>
                  </header>
                  {pendingSentReply ? (
                    <p
                      id="mailbox-sent-reply-pending"
                      className={styles.contentNotice}
                      role="status"
                    >
                      {t("sentReplyPending")}
                    </p>
                  ) : null}
                  {item.kind === "draft" && sendState ? (
                    <p className={styles.contentNotice} role="status">
                      {t(
                        sendState === "requesting"
                          ? "sending"
                          : sendState === "unknown"
                            ? "sendUnknown"
                            : sendState === "failed"
                              ? "sendFailed"
                              : sendState === "accepted"
                                ? "sendAccepted"
                                : sendState === "sending"
                                  ? "sendProcessing"
                                  : "sendQueued",
                      )}
                    </p>
                  ) : null}
                  <div className={styles.messageBody}>{item.text || t("noText")}</div>
                  {item.attachments.length ? (
                    <section aria-label={t("attachments")} className={styles.attachments}>
                      {item.attachments.map((a) => (
                        <Attachment
                          key={`${item.id}:${item.revision}:${a.index}`}
                          item={item}
                          attachment={a}
                        />
                      ))}
                    </section>
                  ) : null}
                </article>
              ) : (
                <div className={styles.hero}>
                  <NavGlyph name="emails" hovered={false} />
                  <h2>{t("selectMessage")}</h2>
                  <p>{t("selectMessageBody")}</p>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>
      {composer && composerAllowed ? (
        <DraftDialog
          key={composer.session}
          boxes={boxes}
          mailboxId={composer.mailboxId}
          source={composer.source}
          mode={composer.mode}
          deliveryReady={deliveryReady}
          current={() => composerSession.current === composer.session}
          close={() => closeComposer(composer.session)}
          selectBox={(id) =>
            compose((current) =>
              current?.session === composer.session ? { ...current, mailboxId: id } : current,
            )
          }
          lost={() => {
            if (composerSession.current !== composer.session) return;
            closeComposer(composer.session);
            setNotice(t("accessLost"));
            void queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
            void refresh();
          }}
          saved={async (saved) => {
            await refresh();
            if (composerSession.current !== composer.session) return;
            setSearch("");
            draftSaved(saved);
          }}
        />
      ) : null}
    </>
  );
}
