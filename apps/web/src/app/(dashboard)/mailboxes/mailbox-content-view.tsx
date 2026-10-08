"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NavGlyph } from "@/components/icons/nav-icons";
import { initialMailboxText, replaceMailboxSignature } from "@/lib/mailbox-compose-signature";
import {
  type MailboxFolder,
  mailboxContentBlocked,
  mailboxListDate,
  mailboxMessageActions,
  mailboxOutboundPresentation,
  mailboxPrimaryParticipant,
  mailboxSendApproval,
} from "@/lib/mailbox-inbox-presentation";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { MailboxFolderIcon } from "./mailbox-folder-icon";
import { MailboxRichBody } from "./mailbox-rich-body";
import styles from "./mailboxes.module.css";

type Outputs = inferRouterOutputs<AppRouter>["mailboxes"];
type Box = Outputs["list"]["mailboxes"][number];
type Item = Outputs["item"];
type Folder = MailboxFolder;
type ComposeMode = "reply" | "forward";
type SendState = "requesting" | Outputs["queueDraft"]["status"];
const NIL = "00000000-0000-0000-0000-000000000000";
function SendResults({
  summary,
  accepted,
}: {
  summary: Item["outboundSummary"];
  accepted: boolean;
}) {
  const t = useTranslations("mailboxes");
  const locale = useLocale();
  const result = mailboxOutboundPresentation(summary);
  return (
    <section className={styles.sendResults} aria-labelledby="mailbox-send-results-title">
      <h3 id="mailbox-send-results-title">{t("results.title")}</h3>
      {accepted ? <p>{t("results.accepted")}</p> : null}
      {result ? (
        <>
          <dl className={styles.resultCounts}>
            <div>
              <dt>{t("results.total")}</dt>
              <dd>{result.total}</dd>
            </div>
            {result.rows.map((row) => (
              <div key={row.key}>
                <dt>{t(`results.${row.key}`)}</dt>
                <dd>{row.count}</dd>
              </div>
            ))}
          </dl>
          {!result.hasConfirmed ? <p>{t("results.empty")}</p> : null}
          {result.partial ? <p>{t("results.partial")}</p> : null}
          {summary?.lastObservedAt ? (
            <p>
              {t("results.lastEvent")}{" "}
              <time dateTime={summary.lastObservedAt.toISOString()}>
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(summary.lastObservedAt)}
              </time>
            </p>
          ) : null}
          <p>{t("results.noReading")}</p>
        </>
      ) : (
        <p>{t("results.unavailable")}</p>
      )}
    </section>
  );
}
function SafetyNotice({
  assessment,
  quarantined,
}: {
  assessment: Outputs["items"]["items"][number]["inboundAssessment"];
  quarantined: boolean;
}) {
  const t = useTranslations("mailboxes");
  return (
    <aside className={styles.safetyNotice} role="status">
      <strong>{t(quarantined ? "safety.quarantineTitle" : "safety.spamTitle")}</strong>
      <p>{t(quarantined ? "safety.quarantineBody" : "safety.spamBody")}</p>
      {assessment?.reasons.length ? (
        <ul>
          {Array.from(new Set(assessment.reasons)).map((reason) => (
            <li key={reason}>{t(`safety.reasons.${reason}`)}</li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
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
  send,
}: {
  boxes: Box[];
  mailboxId: string;
  source: Item | null;
  mode: ComposeMode;
  deliveryReady: boolean;
  close: () => void;
  saved: (item: Outputs["saveDraft"]) => Promise<void>;
  /** Submits the revision just saved: the composer's Send is save, then send. */
  send?: ((item: Outputs["saveDraft"]) => Promise<void>) | undefined;
  lost: () => void;
  selectBox: (id: string) => void;
  current: () => boolean;
}) {
  const t = useTranslations("mailboxes");
  const locale = useLocale();
  const trpc = useTRPC();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recipientInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const boxId = mailboxId;
  const sender = boxes.find((box) => box.id === boxId);
  const canSend = !!send && deliveryReady && sender?.canSend === true;
  const previousSignature = useRef(sender?.signatureText ?? "");
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
  const [text, setText] = useState(() =>
    initialMailboxText(
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
      source?.kind === "draft" ? "" : (sender?.signatureText ?? ""),
      source?.kind !== "draft" && mode === "forward",
    ),
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
    (source && mode !== "forward" ? messageInput.current : recipientInput.current)?.focus();
    if (source?.kind !== "draft") messageInput.current?.setSelectionRange(0, 0);
    return () => {
      active.current = false;
    };
  }, [mode, source]);
  useEffect(() => {
    if (source) return;
    const next = sender?.signatureText ?? "";
    const previous = previousSignature.current;
    setText((value) => replaceMailboxSignature(value, previous, next));
    previousSignature.current = next;
  }, [sender?.signatureText, source]);
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
      <header className={`${styles.dialogHeader} ${styles.composerHeader}`}>
        <div className={styles.composerHeading}>
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
          <p className={styles.composerSender}>
            <span>{t("from")}</span> <strong>{sender?.address}</strong>
          </p>
        </div>
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
        className={styles.composerForm}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current || loadingFiles || !allowed || !current()) return;
          const sendNow =
            canSend && (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "send";
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
            if (sendNow && active.current && current()) await send?.(result);
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
        <div className={styles.composerBody}>
          <fieldset
            className={`${styles.fields} ${styles.composerFields}`}
            disabled={busy || !allowed}
          >
            <div className={styles.composerAddressFields}>
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
                  ref={recipientInput}
                  className="ms-input"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={t("composeRecipientPlaceholder")}
                  maxLength={5100}
                  autoFocus={!source || mode === "forward"}
                />
              </label>
            </div>
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
                ref={messageInput}
                className="ms-input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={262144}
                rows={7}
                autoFocus={!!source && mode !== "forward"}
              />
            </label>
            <div className={styles.composerUpload}>
              <button
                type="button"
                className={`ms-btn ms-btn-ghost ${styles.composerAttachButton}`}
                onClick={() => fileInput.current?.click()}
                aria-describedby="draft-attachment-limit"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3a2 2 0 0 1 3 3L5 17" />
                </svg>
                {t("attach")}
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label={t("attach")}
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <small id="draft-attachment-limit" className={styles.hint}>
                {t("attachmentLimit")}
              </small>
            </div>
            {retained.length + uploads.length > 0 ? (
              <section className={styles.draftAttachments} aria-label={t("attachments")}>
                <h3 className={styles.composerAttachmentSummary}>
                  {t("attachmentsCount", { count: retained.length + uploads.length })}
                </h3>
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
              </section>
            ) : null}
          </fieldset>
          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
        <footer className={`${styles.dialogFooter} ${styles.composerFooter}`}>
          <p className={styles.hint}>
            {t(canSend ? "composeSendHint" : deliveryReady ? "draftSaveFirst" : "draftOnly")}
          </p>
          <div className={styles.composerActions}>
            <button type="button" className="ms-btn" disabled={busy} onClick={dismiss}>
              {t("cancel")}
            </button>
            <button
              type="submit"
              value="draft"
              className={canSend ? "ms-btn" : "ms-btn ms-btn-primary"}
              disabled={busy}
            >
              {t(busy && !canSend ? "saving" : "saveDraft")}
            </button>
            {canSend ? (
              <button type="submit" value="send" className="ms-btn ms-btn-primary" disabled={busy}>
                {t(busy ? "sendingNow" : "send")}
              </button>
            ) : null}
          </div>
        </footer>
      </form>
    </dialog>
  );
}

export function MailboxContentView({
  navigation,
  boxes,
  selected,
  mailboxKind,
  currentUserId,
  folder,
  customFolderId,
  customFolderName,
  manage,
  changeFolder,
  selection,
  select,
  draftSaved,
}: {
  navigation: ReactNode;
  boxes: Box[];
  selected: Box | null;
  mailboxKind: "person" | "agent" | undefined;
  currentUserId: string | undefined;
  folder: Folder;
  customFolderId: string | null;
  customFolderName: string | null;
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
  const moveMutation = useMutation(
    trpc.mailboxes.setDeliveryFolder.mutationOptions({ retry: false }),
  );
  const trashMutation = useMutation(trpc.mailboxes.setTrash.mutationOptions({ retry: false }));
  const starMutation = useMutation(trpc.mailboxes.setStar.mutationOptions({ retry: false }));
  const folderMutation = useMutation(
    trpc.mailboxes.setItemFolder.mutationOptions({ retry: false }),
  );
  const [search, setSearch] = useState("");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [navigationExpanded, setNavigationExpanded] = useState(false);
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
  const moving = useRef(false);
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const reader = useRef<HTMLElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const listing = useQuery(
    trpc.mailboxes.items.queryOptions(
      {
        mailboxId: selected?.id ?? null,
        folder,
        mailboxKind,
        ...(folder === "custom" && customFolderId ? { customFolderId } : {}),
      },
      { retry: false, gcTime: 0, refetchInterval: 15000 },
    ),
  );
  const readable = boxes.filter((b) => b.canRead && b.status === "planned");
  const rows =
    listing.data?.items.filter((i) => {
      const searchable = mailboxContentBlocked(i)
        ? `${i.address} ${i.mailboxLabel}`
        : `${i.subject ?? ""} ${i.from ?? ""} ${i.fromName ?? ""} ${i.to?.join(" ") ?? ""} ${i.snippet ?? ""} ${i.address}`;
      return searchable.toLowerCase().includes(search.toLowerCase().trim());
    }) ?? [];
  const selectedBox = readable.find((b) => b.id === selection?.mailboxId);
  const availableFolders = useQuery(
    trpc.mailboxes.folders.queryOptions(
      { mailboxId: selectedBox?.id ?? NIL },
      { enabled: !!selectedBox, retry: false },
    ),
  );
  const selectedRow =
    !listing.isError && selectedBox
      ? rows.find((i) => i.id === selection?.id && i.mailboxId === selection?.mailboxId)
      : undefined;
  const blockedRow = selectedRow && mailboxContentBlocked(selectedRow) ? selectedRow : null;
  const visibleItem =
    !listing.isError && selectedBox && selectedRow && !blockedRow ? selection : null;
  const readingSelection = visibleItem ?? (blockedRow ? selection : null);
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
  const writable = boxes.filter(
    (b) => b.canDraft && b.status === "planned" && (!mailboxKind || b.kind === mailboxKind),
  );
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
    if (readingSelection) {
      reader.current?.focus({ preventScroll: true });
      if (reader.current) reader.current.scrollTop = 0;
    }
  }, [readingSelection]);
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
  const isOwner = !!selectedBox?.ownerActive && selectedBox.ownerUserId === currentUserId;
  const actionItem = item ?? blockedRow;
  const actions = actionItem
    ? mailboxMessageActions(actionItem, selectedBox?.canDraft === true, isOwner)
    : null;
  const approval = mailboxSendApproval(selectedRow?.sentBy ?? null);
  const canOrganizeItem =
    !!item &&
    isOwner &&
    !item.trashedAt &&
    !mailboxContentBlocked(item) &&
    item.deliveryFolder !== "spam" &&
    !(item.kind === "draft" && item.sendStatus && item.sendStatus !== "failed");
  const rowKey = (row: { mailboxId: string; id: string }) => `${row.mailboxId}:${row.id}`;
  const movableRows = rows.filter((row) => {
    const box = readable.find((candidate) => candidate.id === row.mailboxId);
    return (
      box?.ownerActive &&
      box.ownerUserId === currentUserId &&
      !(row.kind === "draft" && row.sendStatus && row.sendStatus !== "failed")
    );
  });
  const checkedRows = movableRows.filter((row) => checkedIds.has(rowKey(row)));
  const organizationScope = `${folder}:${customFolderId ?? ""}:${selected?.id ?? ""}:${mailboxKind ?? ""}`;
  const previousOrganizationScope = useRef(organizationScope);
  useEffect(() => {
    if (previousOrganizationScope.current !== organizationScope) {
      previousOrganizationScope.current = organizationScope;
      setCheckedIds(new Set());
      setNotice("");
    }
  }, [organizationScope]);
  async function changeStar(row: {
    mailboxId: string;
    id: string;
    revision: number;
    starredAt: Date | null;
  }) {
    if (moving.current || starMutation.isPending) return;
    moving.current = true;
    setNotice("");
    try {
      await starMutation.mutateAsync({
        mailboxId: row.mailboxId,
        id: row.id,
        expectedRevision: row.revision,
        starred: !row.starredAt,
      });
      if (mounted.current)
        setNotice(t(row.starredAt ? "organization.unstarred" : "organization.starred"));
    } catch (cause) {
      if (mounted.current)
        setNotice(
          t(
            (cause as { data?: { code?: string } })?.data?.code === "CONFLICT"
              ? "organization.conflict"
              : "organization.error",
          ),
        );
    } finally {
      moving.current = false;
      if (mounted.current) void refresh();
    }
  }
  async function moveToFolder(id: string | null) {
    if (!item || !canOrganizeItem || moving.current) return;
    moving.current = true;
    setNotice("");
    try {
      await folderMutation.mutateAsync({
        mailboxId: item.mailboxId,
        id: item.id,
        expectedRevision: item.revision,
        folderId: id,
      });
      if (mounted.current) {
        select(null);
        setNotice(t("organization.moved"));
      }
    } catch (cause) {
      if (mounted.current)
        setNotice(
          t(
            (cause as { data?: { code?: string } })?.data?.code === "CONFLICT"
              ? "organization.conflict"
              : "organization.error",
          ),
        );
    } finally {
      moving.current = false;
      if (mounted.current) void refresh();
    }
  }
  async function changeBulkTrash() {
    if (moving.current || !checkedRows.length) return;
    const observed = checkedRows.map((row) => ({
      mailboxId: row.mailboxId,
      id: row.id,
      expectedRevision: row.revision,
      trashed: folder !== "trash",
    }));
    moving.current = true;
    setBulkBusy(true);
    setNotice("");
    let done = 0;
    try {
      for (const input of observed) {
        await trashMutation.mutateAsync(input);
        done += 1;
        if (!mounted.current) break;
      }
      if (mounted.current) {
        select(null);
        setCheckedIds(new Set());
        setNotice(
          t(folder === "trash" ? "organization.bulkRestored" : "organization.bulkTrashed", {
            count: done,
          }),
        );
      }
    } catch {
      if (mounted.current) {
        setCheckedIds(new Set());
        setNotice(t("organization.bulkPartial", { count: done, total: observed.length }));
      }
    } finally {
      moving.current = false;
      if (mounted.current) {
        setBulkBusy(false);
        void refresh();
      }
    }
  }
  async function moveDeliveryFolder(target: "inbox" | "spam") {
    if (
      !item ||
      moving.current ||
      !(target === "inbox" ? actions?.canMoveToInbox : actions?.canMoveToSpam)
    )
      return;
    const observed = { mailboxId: item.mailboxId, id: item.id, expectedRevision: item.revision };
    moving.current = true;
    setNotice("");
    try {
      await moveMutation.mutateAsync({ ...observed, folder: target });
      if (!mounted.current) return;
      setNotice(t(target === "inbox" ? "safety.restored" : "safety.markedSpam"));
      if (
        currentSelection.current?.id === observed.id &&
        currentSelection.current.mailboxId === observed.mailboxId
      ) {
        select(null);
        setSearch("");
        changeFolder(target);
      }
    } catch (cause) {
      if (!mounted.current) return;
      const code = (cause as { data?: { code?: string } })?.data?.code;
      setNotice(t(code === "FORBIDDEN" ? "accessLost" : "safety.moveError"));
    } finally {
      moving.current = false;
      if (mounted.current) void refresh();
    }
  }
  const canSubmitDraft =
    item?.kind === "draft" &&
    !item.trashedAt &&
    selectedBox?.canSend === true &&
    deliveryReady &&
    !sendState;
  async function changeTrash(trashed: boolean) {
    if (!actionItem || moving.current || !(trashed ? actions?.canMoveToTrash : actions?.canRestore))
      return;
    const observed = {
      mailboxId: actionItem.mailboxId,
      id: actionItem.id,
      expectedRevision: actionItem.revision,
    };
    const destination: Folder = trashed
      ? "trash"
      : actionItem.folderId
        ? "trash"
        : actionItem.kind === "draft"
          ? "drafts"
          : actionItem.kind === "sent"
            ? "sent"
            : actionItem.deliveryFolder;
    moving.current = true;
    setNotice("");
    try {
      await trashMutation.mutateAsync({ ...observed, trashed });
      if (!mounted.current) return;
      setNotice(t(trashed ? "trashedNotice" : "restoredNotice"));
      if (
        currentSelection.current?.id === observed.id &&
        currentSelection.current.mailboxId === observed.mailboxId
      ) {
        select(null);
        setSearch("");
        changeFolder(destination);
      }
    } catch (cause) {
      if (!mounted.current) return;
      const code = (cause as { data?: { code?: string } })?.data?.code;
      setNotice(
        t(
          code === "FORBIDDEN"
            ? "accessLost"
            : code === "CONFLICT"
              ? "trashConflict"
              : "trashError",
        ),
      );
    } finally {
      moving.current = false;
      if (mounted.current) void refresh();
    }
  }
  async function submitDraft() {
    if (!item || !sendKey || !canSubmitDraft) return;
    // Capture the displayed revision once. Never retry an uncertain submission,
    // and never substitute a newly selected message while this request is pending.
    await submitRevision({
      mailboxId: item.mailboxId,
      id: item.id,
      expectedRevision: item.revision,
    });
  }
  /** One send of one exact saved revision: from the open draft or the composer's Send. */
  async function submitRevision(revision: {
    mailboxId: string;
    id: string;
    expectedRevision: number;
  }) {
    const key = `${revision.mailboxId}:${revision.id}:${revision.expectedRevision}`;
    if (sending.current || attempted.current.has(key)) return;
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
  const now = new Date();
  const listDate = (value: Date) => mailboxListDate(value, now, locale);
  // Which mailbox a row belongs to matters only when rows of several are mixed.
  const showRowAddress = !selected && readable.length > 1;
  const canCompose = writable.length > 0 && (!selected || selected.canDraft);
  const newDraft = () => openComposer(selected?.id ?? writable[0]!.id, null);
  const folderTitle =
    folder === "custom" ? (customFolderName ?? t("organization.folders")) : t(folder);
  return (
    <>
      <div className={styles.contentWorkspace}>
        <aside
          className={styles.mailFolderRail}
          id="mailbox-folders-navigation"
          data-expanded={navigationExpanded}
          aria-label={t("folders")}
        >
          {navigation}
        </aside>
        <section className={styles.contentToolbar} aria-label={t("mailControls")}>
          <div className={styles.folderHeading}>
            <MailboxFolderIcon name={folder} />
            <h2>{folderTitle}</h2>
          </div>
          <button
            type="button"
            className={`ms-btn ms-btn-ghost ${styles.mobileFolderMenu}`}
            aria-controls="mailbox-folders-navigation"
            aria-expanded={navigationExpanded}
            onClick={() => setNavigationExpanded((value) => !value)}
          >
            <MailboxFolderIcon name="custom" />
            {t("organization.boxesAndFolders")}
          </button>
          {notice ? (
            <p role="alert" className={styles.contentNotice}>
              {notice}
            </p>
          ) : null}
          <div className={styles.contentActions}>
            {manage ? (
              <button type="button" className="ms-btn ms-btn-ghost" onClick={manage}>
                {t("manage")}
              </button>
            ) : null}
            {canCompose ? (
              <button type="button" className="ms-btn ms-btn-primary" onClick={newDraft}>
                <MailboxFolderIcon name="drafts" /> {t("compose")}
              </button>
            ) : null}
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-label={t("refresh")}
              disabled={listing.isFetching}
              onClick={() => void refresh()}
            >
              <MailboxFolderIcon name="refresh" />
            </button>
          </div>
        </section>
        <div className={styles.contentPanels} data-empty={!hasRows}>
          <div
            className={`${styles.list} ${styles.contentList}`}
            data-reading={!!visibleItem || !!blockedRow}
          >
            <div className={styles.listSearch}>
              {folder === "trash" ? (
                <p className={styles.trashHelp}>{t("organization.trashHelp")}</p>
              ) : null}
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
              {listing.data?.limited ? (
                <p className={styles.trashHelp}>{t("organization.limitedList")}</p>
              ) : null}
              {!listing.isPending && !listing.isError ? (
                <div className={styles.selectionToolbar}>
                  {movableRows.length ? (
                    <label>
                      <input
                        type="checkbox"
                        className="ms-checkbox"
                        ref={(input) => {
                          if (input)
                            input.indeterminate =
                              checkedRows.length > 0 && checkedRows.length < movableRows.length;
                        }}
                        checked={checkedRows.length === movableRows.length}
                        disabled={bulkBusy}
                        onChange={(event) =>
                          setCheckedIds(
                            event.target.checked ? new Set(movableRows.map(rowKey)) : new Set(),
                          )
                        }
                      />
                      {t("organization.selectAll")}
                    </label>
                  ) : null}
                  {checkedRows.length ? (
                    <button
                      type="button"
                      className="ms-btn ms-btn-ghost"
                      disabled={bulkBusy}
                      onClick={() => void changeBulkTrash()}
                    >
                      <MailboxFolderIcon name={folder === "trash" ? "restore" : "trash"} />
                      {t(
                        folder === "trash"
                          ? "organization.restoreSelected"
                          : "organization.trashSelected",
                        { count: checkedRows.length },
                      )}
                    </button>
                  ) : (
                    <span className={styles.messageCount}>
                      {t("messageCount", { count: rows.length })}
                    </span>
                  )}
                </div>
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
                  {rows.map((row) => {
                    const blocked = mailboxContentBlocked(row);
                    const participant = mailboxPrimaryParticipant(row);
                    const rowApproval = mailboxSendApproval(row.sentBy);
                    const ownerBox = readable.find((box) => box.id === row.mailboxId);
                    const rowOrganizable =
                      ownerBox?.ownerActive &&
                      ownerBox.ownerUserId === currentUserId &&
                      !blocked &&
                      !row.trashedAt &&
                      row.deliveryFolder !== "spam" &&
                      !(row.kind === "draft" && row.sendStatus && row.sendStatus !== "failed");
                    const rowStatus =
                      blocked ||
                      !!rowApproval ||
                      (!!row.approvalRequested && !row.sendStatus) ||
                      !!row.sendStatus;
                    return (
                      <div className={styles.messageRow} key={rowKey(row)}>
                        <div className={styles.rowQuickActions}>
                          {movableRows.some((entry) => rowKey(entry) === rowKey(row)) ? (
                            <label className={styles.rowSelectionTarget}>
                              <input
                                type="checkbox"
                                className="ms-checkbox"
                                aria-label={t("organization.selectMessage", {
                                  subject: blocked
                                    ? t("safety.blockedMessage")
                                    : row.subject || t("noSubject"),
                                })}
                                checked={checkedIds.has(rowKey(row))}
                                disabled={bulkBusy}
                                onChange={(event) =>
                                  setCheckedIds((previous) => {
                                    const next = new Set(previous);
                                    if (event.target.checked) next.add(rowKey(row));
                                    else next.delete(rowKey(row));
                                    return next;
                                  })
                                }
                              />
                            </label>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className={styles.messageRowOpen}
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
                              {blocked
                                ? t("safety.quarantineTitle")
                                : participant || t("noRecipient")}
                            </span>
                            {!blocked && row.attachmentCount ? (
                              <span
                                className={styles.rowAttachment}
                                role="img"
                                aria-label={t("attachmentsCount", { count: row.attachmentCount })}
                                title={t("attachmentsCount", { count: row.attachmentCount })}
                              >
                                <MailboxFolderIcon name="attachment" />
                              </span>
                            ) : null}
                            <time title={date(row.date)} dateTime={row.date.toISOString()}>
                              {listDate(row.date)}
                            </time>
                          </div>
                          <strong>
                            {blocked ? t("safety.blockedMessage") : row.subject || t("noSubject")}
                          </strong>
                          <p>{blocked ? t("safety.blockedPreview") : row.snippet}</p>
                          {rowStatus ? (
                            <div className={styles.rowBadges}>
                              {blocked ? (
                                <span className={styles.warningBadge}>{t("quarantine")}</span>
                              ) : null}
                              {!blocked && rowApproval ? (
                                <span>
                                  {t(rowApproval.key, {
                                    label: "label" in rowApproval ? rowApproval.label : "",
                                  })}
                                </span>
                              ) : null}
                              {!blocked && row.approvalRequested && !row.sendStatus ? (
                                <span className={styles.warningBadge}>
                                  {t("approval.requested")}
                                </span>
                              ) : null}
                              {!blocked && row.sendStatus ? (
                                <span>{t(`deliveryStatus.${row.sendStatus}`)}</span>
                              ) : null}
                            </div>
                          ) : null}
                          {showRowAddress ? (
                            <small className={styles.rowAddress} title={row.address}>
                              {row.address}
                            </small>
                          ) : null}
                        </button>
                        {rowOrganizable ? (
                          <button
                            type="button"
                            className={`${styles.starButton} ${styles.rowStar}`}
                            aria-label={t(
                              row.starredAt
                                ? "organization.removeFavorite"
                                : "organization.addFavorite",
                            )}
                            aria-pressed={!!row.starredAt}
                            disabled={starMutation.isPending || bulkBusy}
                            onClick={() => void changeStar(row)}
                          >
                            <MailboxFolderIcon name="favorites" filled={!!row.starredAt} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyFolder}>
                  <NavGlyph name="emails" hovered={false} />
                  <h3>
                    {t(
                      search
                        ? "noMessageMatches"
                        : folder === "trash"
                          ? "trashEmptyTitle"
                          : folder === "quarantine"
                            ? "safety.quarantineEmptyTitle"
                            : folder === "spam"
                              ? "safety.spamEmptyTitle"
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
                        : folder === "trash"
                          ? "trashEmptyBody"
                          : folder === "quarantine"
                            ? "safety.quarantineEmptyBody"
                            : folder === "spam"
                              ? "safety.spamEmptyBody"
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
                  ) : canCompose && (folder === "inbox" || folder === "drafts") ? (
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
              data-reading={!!visibleItem || !!blockedRow}
            >
              <div className={styles.detailTop}>
                <button
                  type="button"
                  className={`ms-btn ms-btn-ghost ${styles.mobileBack}`}
                  onClick={backToList}
                >
                  ← {t("back")}
                </button>
                {item || blockedRow ? null : (
                  <span title={selectedBox?.address ?? selected?.address}>
                    {selectedBox?.address ?? selected?.address ?? t("all")}
                  </span>
                )}
                {item && actions?.canRespond ? (
                  <div className={`${styles.contentActions} ${styles.replyActions}`}>
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
                      <MailboxFolderIcon name={item.kind === "draft" ? "drafts" : "reply"} />
                      {t(item.kind === "draft" ? "editDraft" : "replyDraft")}
                    </button>
                    {item.kind !== "draft" ? (
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost"
                        aria-label={t("forward")}
                        onClick={() => openComposer(item.mailboxId, item, "forward")}
                      >
                        <MailboxFolderIcon name="forward" />
                        <span className={styles.narrowHidden}>{t("forward")}</span>
                      </button>
                    ) : selectedBox?.canSend && deliveryReady ? (
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
                {canOrganizeItem && item ? (
                  <div className={styles.organizationActions}>
                    {!availableFolders.isError ? (
                      <label>
                        <span className={styles.visuallyHidden}>
                          {t("organization.moveToFolder")}
                        </span>
                        <select
                          className="ms-input"
                          aria-label={t("organization.moveToFolder")}
                          value={item.folderId ?? ""}
                          disabled={
                            folderMutation.isPending || availableFolders.isPending || bulkBusy
                          }
                          onChange={(event) => void moveToFolder(event.target.value || null)}
                        >
                          <option value="">
                            {t(
                              item.folderId
                                ? "organization.removeFromFolder"
                                : "organization.moveToFolderPlaceholder",
                            )}
                          </option>
                          {availableFolders.data?.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className={`ms-btn ms-btn-ghost ${styles.starButton}`}
                      aria-label={t(
                        item.starredAt ? "organization.removeFavorite" : "organization.addFavorite",
                      )}
                      aria-pressed={!!item.starredAt}
                      disabled={starMutation.isPending || bulkBusy}
                      onClick={() => void changeStar(item)}
                    >
                      <MailboxFolderIcon name="favorites" filled={!!item.starredAt} />
                    </button>
                  </div>
                ) : null}
                {actions?.canMoveToInbox || actions?.canMoveToSpam ? (
                  <button
                    type="button"
                    className={`ms-btn ms-btn-ghost ${styles.iconAction}`}
                    disabled={moveMutation.isPending}
                    aria-label={t(actions.canMoveToInbox ? "safety.notSpam" : "safety.markSpam")}
                    title={t(actions.canMoveToInbox ? "safety.notSpam" : "safety.markSpam")}
                    onClick={() =>
                      void moveDeliveryFolder(actions.canMoveToInbox ? "inbox" : "spam")
                    }
                  >
                    <MailboxFolderIcon name={actions.canMoveToInbox ? "inbox" : "spam"} />
                    {moveMutation.isPending ? <span>{t("safety.moving")}</span> : null}
                  </button>
                ) : null}
                {actions?.canMoveToTrash || actions?.canRestore ? (
                  <button
                    type="button"
                    className={`ms-btn ms-btn-ghost ${actions.canRestore ? styles.restoreAction : `${styles.dangerAction} ${styles.iconAction}`}`}
                    disabled={
                      trashMutation.isPending ||
                      bulkBusy ||
                      moveMutation.isPending ||
                      !!(actionItem?.kind === "draft" && sendState && sendState !== "failed")
                    }
                    aria-label={actions.canRestore ? undefined : t("moveToTrash")}
                    title={actions.canRestore ? undefined : t("moveToTrash")}
                    onClick={() => void changeTrash(!actions.canRestore)}
                  >
                    <MailboxFolderIcon name={actions.canRestore ? "restore" : "trash"} />
                    {trashMutation.isPending ? (
                      <span>{t("movingTrash")}</span>
                    ) : actions.canRestore ? (
                      t("restoreMessage")
                    ) : null}
                  </button>
                ) : null}
              </div>
              {blockedRow ? (
                <div className={styles.quarantineDetail}>
                  <p className={styles.address}>{blockedRow.address}</p>
                  <h2>{t("safety.blockedMessage")}</h2>
                  <time dateTime={blockedRow.date.toISOString()}>{date(blockedRow.date)}</time>
                  <SafetyNotice assessment={blockedRow.inboundAssessment} quarantined />
                </div>
              ) : detail.isError && visibleItem ? (
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
                  {item.trashedAt ? (
                    <p className={styles.contentNotice}>{t("trashMessageHelp")}</p>
                  ) : null}
                  {item.kind === "inbox" && item.deliveryFolder === "spam" ? (
                    <SafetyNotice assessment={item.inboundAssessment} quarantined={false} />
                  ) : null}
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
                  <div className={styles.messageBadges}>
                    {approval ? (
                      <span>
                        {t(approval.key, { label: "label" in approval ? approval.label : "" })}
                      </span>
                    ) : null}
                    {item.kind === "sent" && selectedRow?.sendStatus ? (
                      <span>{t(`deliveryStatus.${selectedRow.sendStatus}`)}</span>
                    ) : null}
                  </div>
                  {item.kind === "draft" &&
                  selectedRow?.approvalRequested &&
                  !selectedRow.sendStatus ? (
                    <p className={styles.contentNotice} role="status">
                      {selectedRow.approvalRequested.agentLabel
                        ? t("approval.requestedNotice", {
                            label: selectedRow.approvalRequested.agentLabel,
                          })
                        : t("approval.requestedNoticeUnnamed")}
                    </p>
                  ) : null}
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
                  {item.kind === "sent" || (item.kind === "draft" && item.outboundSummary) ? (
                    <SendResults
                      summary={item.outboundSummary}
                      accepted={item.sendStatus === "accepted"}
                    />
                  ) : null}
                  <MailboxRichBody
                    key={`${item.id}:${item.revision}`}
                    text={item.text}
                    html={item.htmlBody}
                    externalHtml={item.htmlBodyWithExternalImages}
                    externalImages={item.externalImages}
                  />
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
          send={(saved) =>
            submitRevision({
              mailboxId: saved.mailboxId,
              id: saved.id,
              expectedRevision: saved.revision,
            })
          }
        />
      ) : null}
    </>
  );
}
