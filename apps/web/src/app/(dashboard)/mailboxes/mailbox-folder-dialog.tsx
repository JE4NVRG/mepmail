"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { mailboxFolderTint } from "@/lib/mailbox-inbox-presentation";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailboxes.module.css";

type Folder = inferRouterOutputs<AppRouter>["mailboxes"]["folders"][number];
type FolderColor = Folder["color"];

/** The server's named colors in the order the swatches show them. */
const COLORS = ["violet", "blue", "green", "amber", "red", "pink", "teal", "gray"] as const;

const TINT_CLASS: Record<(typeof COLORS)[number], string> = {
  violet: "tintViolet",
  blue: "tintBlue",
  green: "tintGreen",
  amber: "tintAmber",
  red: "tintRed",
  pink: "tintPink",
  teal: "tintTeal",
  gray: "tintGray",
};

/**
 * A folder's name and color, or removing it. Creation and quick renames are
 * inline in the rail (MailboxFolderEditor); this dialog is where the color
 * lives and where a folder is removed.
 */
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
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState<FolderColor>(folder?.color ?? null);
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const create = useMutation(trpc.mailboxes.createFolder.mutationOptions({ retry: false }));
  const update = useMutation(trpc.mailboxes.updateFolder.mutationOptions({ retry: false }));
  const archive = useMutation(trpc.mailboxes.archiveFolder.mutationOptions({ retry: false }));
  const busy = create.isPending || update.isPending || archive.isPending;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function refresh(next: string | null) {
    await Promise.all([
      queries.invalidateQueries({ queryKey: trpc.mailboxes.folders.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.items.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.item.queryKey() }),
    ]);
    changed(next);
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
      aria-labelledby={`${id}-title`}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={styles.dialogHeader}>
        <h2 id={`${id}-title`}>
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
              return;
            }
            const trimmed = name.trim();
            if (folder) {
              const patch = {
                ...(trimmed !== folder.name ? { name: trimmed } : {}),
                ...(color !== (folder.color ?? null) ? { color } : {}),
              };
              if (!("name" in patch) && !("color" in patch)) {
                close();
                return;
              }
              const result = await update.mutateAsync({
                mailboxId,
                id: folder.id,
                expectedRevision: folder.revision,
                ...patch,
              });
              await refresh(result.id);
              return;
            }
            const result = await create.mutateAsync({
              mailboxId,
              name: trimmed,
              ...(color ? { color } : {}),
            });
            await refresh(result.id);
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
            <fieldset className={styles.folderColors} disabled={busy}>
              <legend>{t("color")}</legend>
              <label className={styles.folderSwatch} data-tint="none" title={t("noColor")}>
                <input
                  type="radio"
                  name={`${id}-color`}
                  value=""
                  checked={color === null}
                  onChange={() => setColor(null)}
                />
                <span data-dot="" aria-hidden="true" />
                <span className={styles.visuallyHidden}>{t("noColor")}</span>
              </label>
              {COLORS.map((entry) => (
                <label
                  key={entry}
                  className={`${styles.folderSwatch} ${styles[TINT_CLASS[entry]]}`}
                  data-tint={entry}
                  title={t(`colors.${entry}`)}
                >
                  <input
                    type="radio"
                    name={`${id}-color`}
                    value={entry}
                    checked={mailboxFolderTint(color) === entry}
                    onChange={() => setColor(entry)}
                  />
                  <span data-dot="" aria-hidden="true" />
                  <span className={styles.visuallyHidden}>{t(`colors.${entry}`)}</span>
                </label>
              ))}
            </fieldset>
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
