"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "@/components/toast";
import { mailboxFolderTint } from "@/lib/mailbox-inbox-presentation";
import { mailboxMoveOptions } from "@/lib/mailbox-move";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-move-menu.module.css";

export type MailboxMoveMenuHandle = { open: () => void };

type Option =
  | { kind: "folder"; id: string; name: string; color: string | null }
  | { kind: "remove" }
  | { kind: "create"; name: string };

const GAP = 6;

function MoveGlyph() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h7l2 3h9v12H3z M9 15h7 M13 12l3 3-3 3" />
    </svg>
  );
}

/**
 * "Move to": the folders of the message's mailbox with a search field; typing
 * a name that is not a folder yet offers to create it and move there in one
 * step. Arrow keys pick, Enter moves, Escape closes. On a phone the list
 * opens as a sheet at the bottom of the screen.
 */
export const MailboxMoveMenu = forwardRef<
  MailboxMoveMenuHandle,
  {
    mailboxId: string;
    currentFolderId: string | null;
    canCreate: boolean;
    disabled?: boolean;
    variant?: "icon" | "button";
    /** Moves to the folder (null takes it out of any folder); false when the move failed. */
    onMove: (folderId: string | null) => Promise<boolean>;
  }
>(function MailboxMoveMenu(
  { mailboxId, currentFolderId, canCreate, disabled = false, variant = "icon", onMove },
  ref,
) {
  const t = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ style?: CSSProperties; sheet: boolean }>({ sheet: false });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const folders = useQuery(
    trpc.mailboxes.folders.queryOptions({ mailboxId }, { enabled: open, retry: false }),
  );
  const create = useMutation(trpc.mailboxes.createFolder.mutationOptions({ retry: false }));

  function show() {
    if (disabled) return;
    const rect = trigger.current?.getBoundingClientRect();
    const sheet = window.matchMedia("(max-width: 620px)").matches;
    if (!rect || sheet) setPlace({ sheet: true });
    else {
      const viewportW = document.documentElement.clientWidth;
      const viewportH = document.documentElement.clientHeight;
      const up = rect.bottom + GAP + 340 > viewportH && rect.top > viewportH - rect.bottom;
      setPlace({
        sheet: false,
        style: {
          position: "fixed",
          ...(up ? { bottom: viewportH - rect.top + GAP } : { top: rect.bottom + GAP }),
          right: Math.max(12, viewportW - rect.right),
        },
      });
    }
    setQuery("");
    setActive(0);
    setOpen(true);
  }
  useImperativeHandle(ref, () => ({ open: show }));

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    input.current?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    }
    // The panel is pinned to where the trigger was; a scroll or resize detaches it.
    function onReflow(event: Event) {
      if (panel.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  const { matches, createName } = mailboxMoveOptions(folders.data ?? [], query);
  const options: Option[] = [
    ...matches.map((folder) => ({
      kind: "folder" as const,
      id: folder.id,
      name: folder.name,
      color: folder.color ?? null,
    })),
    ...(currentFolderId && !query.trim() ? [{ kind: "remove" as const }] : []),
    ...(canCreate && createName && !folders.isPending
      ? [{ kind: "create" as const, name: createName }]
      : []),
  ];
  const current = Math.min(active, Math.max(0, options.length - 1));

  async function choose(option: Option) {
    close();
    if (option.kind === "folder") {
      if (option.id !== currentFolderId) await onMove(option.id);
      return;
    }
    if (option.kind === "remove") {
      await onMove(null);
      return;
    }
    let created: { id: string; name: string };
    try {
      const folder = await create.mutateAsync({ mailboxId, name: option.name });
      created = { id: folder.id, name: folder.name ?? option.name };
    } catch (cause) {
      const code = (cause as { data?: { code?: string } })?.data?.code;
      toast(t(code === "CONFLICT" ? "organization.nameTaken" : "organization.error"), "warn");
      return;
    }
    void queries.invalidateQueries({ queryKey: trpc.mailboxes.folders.queryKey() });
    const moved = await onMove(created.id);
    toast(
      moved
        ? t("organization.folderCreated", { name: created.name })
        : t("organization.createdNotMoved", { name: created.name }),
      moved ? "neutral" : "warn",
    );
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!options.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + options.length) % options.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[current];
      if (option) void choose(option);
    }
  }

  const label = (option: Option) =>
    option.kind === "folder"
      ? option.name
      : option.kind === "remove"
        ? t("organization.removeFromFolder")
        : t("organization.createAndMove", { name: option.name });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={
          variant === "icon"
            ? `ms-btn ms-btn-ghost ${styles.iconTrigger}`
            : `ms-btn ms-btn-ghost ms-btn-sm ${styles.buttonTrigger}`
        }
        aria-label={t("organization.moveTo")}
        title={t("organization.moveTo")}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        <MoveGlyph />
        {variant === "button" ? <span>{t("organization.moveTo")}</span> : null}
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              role="dialog"
              aria-label={t("organization.moveTo")}
              // The phone sheet spans the screen; the shared menu class caps menus at 320 px there.
              className={place.sheet ? styles.panel : `ms-menu ${styles.panel}`}
              data-sheet={place.sheet || undefined}
              style={place.style}
              onKeyDown={onKeyDown}
            >
              <input
                ref={input}
                type="text"
                role="combobox"
                className={`ms-input ${styles.search}`}
                value={query}
                maxLength={120}
                placeholder={t(
                  canCreate ? "organization.moveToSearch" : "organization.moveToFilter",
                )}
                aria-label={t(
                  canCreate ? "organization.moveToSearch" : "organization.moveToFilter",
                )}
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={options.length ? `${id}-${current}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
              />
              <div
                id={`${id}-list`}
                role="listbox"
                aria-label={t("organization.moveTo")}
                className={styles.list}
              >
                {options.map((option, index) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input above picks options with the arrow keys and Enter (aria-activedescendant)
                  <div
                    key={option.kind === "folder" ? option.id : option.kind}
                    id={`${id}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === current}
                    className={`ms-menu-item ${styles.option}`}
                    data-active={index === current || undefined}
                    data-kind={option.kind}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void choose(option)}
                  >
                    {option.kind === "folder" ? (
                      <span
                        className={styles.dot}
                        data-tint={mailboxFolderTint(option.color) ?? undefined}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className={styles.name}>{label(option)}</span>
                    {option.kind === "folder" && option.id === currentFolderId ? (
                      <span className={styles.check} aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </div>
                ))}
                {folders.isPending ? (
                  <p className={styles.state}>{t("loading")}</p>
                ) : folders.isError ? (
                  <p className={styles.state}>{t("organization.error")}</p>
                ) : !options.length ? (
                  <p className={styles.state}>{t("organization.noFolderMatches")}</p>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
});
