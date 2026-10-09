"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailboxes.module.css";

/** What the inline editor is doing: a new folder in a mailbox, or a new name. */
export type FolderEditorState =
  | { mode: "create"; mailboxId: string | null }
  | {
      mode: "rename";
      mailboxId: string;
      folder: { id: string; name: string; revision: number };
    };

/**
 * Creates or renames a folder right where the folder list is: Enter saves,
 * Escape cancels, a taken name is reported next to the field. In the unified
 * view a new folder also asks which mailbox it belongs to.
 */
export function MailboxFolderEditor({
  editor,
  mailboxes,
  onDone,
  onCancel,
}: {
  editor: FolderEditorState;
  /** The person's own mailboxes a new folder may belong to. */
  mailboxes: { id: string; label: string; address: string }[];
  onDone: (result: { mailboxId: string; id: string; name: string; created: boolean }) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("mailboxes.organization");
  const common = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editor.mode === "rename" ? editor.folder.name : "");
  const [mailboxId, setMailboxId] = useState(editor.mailboxId ?? mailboxes[0]?.id ?? "");
  const [error, setError] = useState("");
  const create = useMutation(trpc.mailboxes.createFolder.mutationOptions({ retry: false }));
  const rename = useMutation(trpc.mailboxes.updateFolder.mutationOptions({ retry: false }));
  const busy = create.isPending || rename.isPending;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setError("");
    try {
      if (editor.mode === "rename") {
        if (value === editor.folder.name) {
          onCancel();
          return;
        }
        const result = await rename.mutateAsync({
          mailboxId: editor.mailboxId,
          id: editor.folder.id,
          expectedRevision: editor.folder.revision,
          name: value,
        });
        await queries.invalidateQueries({ queryKey: trpc.mailboxes.folders.queryKey() });
        onDone({ mailboxId: editor.mailboxId, id: result.id, name: value, created: false });
        return;
      }
      if (!mailboxId) return;
      const result = await create.mutateAsync({ mailboxId, name: value });
      await queries.invalidateQueries({ queryKey: trpc.mailboxes.folders.queryKey() });
      onDone({ mailboxId, id: result.id, name: value, created: true });
    } catch (cause) {
      const code = (cause as { data?: { code?: string } })?.data?.code;
      setError(
        t(code === "CONFLICT" ? (editor.mode === "create" ? "nameTaken" : "conflict") : "error"),
      );
      input.current?.focus();
    }
  }

  return (
    <form
      className={styles.folderEditor}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      {editor.mode === "create" && mailboxes.length > 1 ? (
        <select
          className="ms-input"
          aria-label={t("newFolderIn")}
          value={mailboxId}
          disabled={busy}
          onChange={(event) => setMailboxId(event.target.value)}
        >
          {mailboxes.map((box) => (
            <option key={box.id} value={box.id}>
              {box.label} · {box.address}
            </option>
          ))}
        </select>
      ) : null}
      <input
        ref={input}
        className="ms-input"
        value={name}
        maxLength={80}
        placeholder={t("folderNamePlaceholder")}
        aria-label={t("folderName")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      <div className={styles.folderEditorActions}>
        <button
          type="submit"
          className="ms-btn ms-btn-primary ms-btn-sm"
          disabled={busy || !name.trim()}
        >
          {t(editor.mode === "rename" ? "saveName" : "createFolder")}
        </button>
        <button
          type="button"
          className="ms-btn ms-btn-ghost ms-btn-sm"
          disabled={busy}
          onClick={onCancel}
        >
          {common("cancel")}
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className={styles.folderEditorError}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
