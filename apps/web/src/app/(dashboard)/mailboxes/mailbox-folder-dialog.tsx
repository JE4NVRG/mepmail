"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailboxes.module.css";

type Folder = inferRouterOutputs<AppRouter>["mailboxes"]["folders"][number];

export function MailboxFolderDialog({
  mailboxId,
  folder,
  close,
  changed,
}: {
  mailboxId: string;
  folder: Folder | null;
  close: () => void;
  changed: (id: string | null) => void;
}) {
  const t = useTranslations("mailboxes.organization");
  const common = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(folder?.name ?? "");
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const create = useMutation(trpc.mailboxes.createFolder.mutationOptions({ retry: false }));
  const rename = useMutation(trpc.mailboxes.updateFolder.mutationOptions({ retry: false }));
  const archive = useMutation(trpc.mailboxes.archiveFolder.mutationOptions({ retry: false }));
  const busy = create.isPending || rename.isPending || archive.isPending;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function refresh(id: string | null) {
    await Promise.all([
      queries.invalidateQueries({ queryKey: trpc.mailboxes.folders.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.items.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.item.queryKey() }),
    ]);
    changed(id);
    close();
  }
  function fail(cause: unknown) {
    const code = (cause as { data?: { code?: string } })?.data?.code;
    setError(t(code === "CONFLICT" ? "conflict" : "error"));
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="mail-folder-title"
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={styles.dialogHeader}>
        <h2 id="mail-folder-title">
          {t(archiving ? "archiveTitle" : folder ? "editFolder" : "createFolder")}
        </h2>
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
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            if (archiving && folder) {
              await archive.mutateAsync({
                mailboxId,
                id: folder.id,
                expectedRevision: folder.revision,
              });
              await refresh(null);
            } else {
              const result = folder
                ? await rename.mutateAsync({
                    mailboxId,
                    id: folder.id,
                    expectedRevision: folder.revision,
                    name: name.trim(),
                  })
                : await create.mutateAsync({ mailboxId, name: name.trim() });
              await refresh(result.id);
            }
          } catch (cause) {
            fail(cause);
          }
        }}
      >
        {archiving ? (
          <p className={styles.folderHelp}>{t("archiveHelp", { name: folder?.name ?? "" })}</p>
        ) : (
          <>
            <p className={styles.folderHelp}>{t("folderHelp")}</p>
            <label className={styles.folderName}>
              {t("folderName")}
              <input
                className="ms-input"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                disabled={busy}
                autoFocus
              />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <footer className={styles.dialogFooter}>
          {folder && !archiving ? (
            <button
              type="button"
              className={`ms-btn ms-btn-ghost ${styles.dangerAction}`}
              disabled={busy}
              onClick={() => {
                setError("");
                setArchiving(true);
              }}
            >
              {t("archiveFolder")}
            </button>
          ) : null}
          <button
            type="button"
            className="ms-btn"
            disabled={busy}
            onClick={() => (archiving ? setArchiving(false) : close())}
          >
            {common("cancel")}
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={busy || (!archiving && !name.trim())}
          >
            {common(busy ? "saving" : "save")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
