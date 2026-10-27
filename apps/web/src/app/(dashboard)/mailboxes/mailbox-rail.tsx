"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { PopoverMenu, type PopoverMenuItem } from "@/components/popover-menu";
import type { MailboxFolder, MailboxKindFilter } from "@/lib/mailbox-inbox-presentation";
import { mailboxAvatarHue, mailboxInitials } from "@/lib/mailbox-list-presentation";
import {
  applyRailCollapsed,
  type MailboxRailBox,
  mailboxRailGroups,
  RAIL_SEARCH_THRESHOLD,
  readRailCollapsed,
} from "@/lib/mailbox-rail";
import { MailboxFolderIcon } from "./mailbox-folder-icon";
import { MailboxHelpMenu } from "./mailbox-help-menu";
import styles from "./mailbox-rail.module.css";

const PRIMARY: MailboxFolder[] = ["inbox", "sent", "drafts", "favorites", "archive"];
const MORE: MailboxFolder[] = ["snoozed", "followups", "scheduled", "spam", "quarantine"];
const DROPPABLE = new Set<MailboxFolder>(["inbox", "favorites", "archive", "spam", "trash"]);

type DropProps = Record<string, unknown>;

/**
 * The Correio side rail: every mailbox grouped by use with its unread count,
 * the selected mailbox and its actions, the system folders and the person's
 * own folders. Everyday folders stay first; mailboxes open in a bounded picker.
 * It collapses to icons by choice on this device, keeps a compact
 * readable width on tablets, and becomes a full-screen drawer on a phone.
 */
export function MailboxRail({
  boxes,
  selectedId,
  scope,
  folder,
  unread,
  inboxUnread,
  schedules,
  expanded,
  onClose,
  onSelectBox,
  onScope,
  onFolder,
  onPrefetch,
  dropProps,
  boxesMenu,
  boxMenu,
  folders,
  usage,
  onShortcuts,
}: {
  boxes: MailboxRailBox[];
  selectedId: string | null;
  scope: MailboxKindFilter;
  folder: MailboxFolder;
  unread: Record<string, number>;
  inboxUnread: number;
  /** Waiting in Snoozed, Scheduled and Follow-ups. */
  schedules: { snoozed: number; scheduled: number; followUps: number } | null;
  /** The phone drawer is open. */
  expanded: boolean;
  onClose: () => void;
  onSelectBox: (id: string) => void;
  onScope: (kind: MailboxKindFilter) => void;
  onFolder: (folder: MailboxFolder) => void;
  /** Reads a folder's first page ahead when the pointer or focus reaches it. */
  onPrefetch?: (folder: MailboxFolder) => void;
  dropProps: (target: { folder: MailboxFolder }, key: string) => DropProps;
  boxesMenu: (PopoverMenuItem | null)[];
  boxMenu: (PopoverMenuItem | null)[];
  folders: ReactNode;
  usage: ReactNode;
  onShortcuts: () => void;
}) {
  const t = useTranslations("mailboxes");
  const id = useId();
  const rail = useRef<HTMLElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const [boxesOpen, setBoxesOpen] = useState(false);
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState<Partial<Record<"person" | "agent", boolean>>>({});
  const [moreOpen, setMoreOpen] = useState(() => MORE.includes(folder));
  // Spam and quarantine stay in view while one of them is open.
  useEffect(() => {
    if (MORE.includes(folder)) setMoreOpen(true);
  }, [folder]);
  // Whether the rail shows icons only right now (by choice or by width).
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    applyRailCollapsed(readRailCollapsed(), false);
    const node = rail.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < 100);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const drawer = () => !!rail.current && getComputedStyle(rail.current).position === "fixed";
  // The phone drawer takes the focus while open and gives it back on close.
  useEffect(() => {
    const node = rail.current;
    if (!expanded || !node || getComputedStyle(node).position !== "fixed") return;
    const previous = document.activeElement as HTMLElement | null;
    node.querySelector<HTMLElement>("[data-drawer-close]")?.focus();
    return () => previous?.focus?.();
  }, [expanded]);
  function onKeyDown(event: KeyboardEvent) {
    if (boxesOpen && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (!expanded || !drawer()) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !rail.current) return;
    const nodes = Array.from(
      rail.current.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ),
    ).filter((node) => node.offsetParent !== null);
    const first = nodes[0];
    const last = nodes.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function closePicker(restoreFocus = false) {
    setBoxesOpen(false);
    setQuery("");
    if (restoreFocus) pickerButton.current?.focus({ preventScroll: true });
  }
  // The mailbox switcher is a disclosure, not a second long navigation rail.
  // Its bounded panel never moves the everyday folders below a growing list.
  useEffect(() => {
    if (!boxesOpen) return;
    const panel = picker.current?.querySelector<HTMLElement>("[data-mailbox-picker-panel]");
    (
      panel?.querySelector<HTMLInputElement>('input[type="search"]') ??
      panel?.querySelector<HTMLButtonElement>("[data-mailbox-scope]")
    )?.focus({
      preventScroll: true,
    });
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) {
        setBoxesOpen(false);
        setQuery("");
      }
    };
    const handlePickerEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setBoxesOpen(false);
      setQuery("");
      pickerButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handlePickerEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handlePickerEscape);
      applyRailCollapsed(readRailCollapsed(), false);
    };
  }, [boxesOpen]);
  useEffect(() => {
    if (!expanded) setBoxesOpen(false);
  }, [expanded]);

  const groups = mailboxRailGroups(boxes, { query, expanded: showAll, selectedId });
  const selected = boxes.find((box) => box.id === selectedId) ?? null;
  const unreadLabel = (count: number) => t("organization.unreadCount", { count });
  const pill = (count: number) =>
    count > 0 ? (
      <span className={styles.count} role="img" aria-label={unreadLabel(count)}>
        {count > 999 ? "999+" : count}
      </span>
    ) : null;
  // A count that informs without asking for attention (no violet).
  const quiet = (count: number) =>
    count > 0 ? (
      <span className={styles.quietCount} role="img" aria-label={t("rail.waiting", { count })}>
        {count > 999 ? "999+" : count}
      </span>
    ) : null;
  const folderAccessibleLabel = (entry: MailboxFolder) => {
    const waiting =
      entry === "snoozed"
        ? schedules?.snoozed
        : entry === "scheduled"
          ? schedules?.scheduled
          : entry === "followups"
            ? schedules?.followUps
            : 0;
    return [
      t(entry),
      entry === "inbox" && inboxUnread > 0
        ? unreadLabel(inboxUnread)
        : waiting
          ? t("rail.waiting", { count: waiting })
          : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const folderButton = (entry: MailboxFolder) => (
    <button
      type="button"
      key={entry}
      className={styles.item}
      aria-current={entry === folder ? "page" : undefined}
      title={t(entry)}
      data-mailbox-folder={entry}
      aria-label={folderAccessibleLabel(entry)}
      onClick={() => {
        closePicker();
        onFolder(entry);
      }}
      onPointerEnter={() => {
        if (hover.current) clearTimeout(hover.current);
        hover.current = setTimeout(() => onPrefetch?.(entry), 120);
      }}
      onPointerLeave={() => {
        if (hover.current) clearTimeout(hover.current);
      }}
      onFocus={() => onPrefetch?.(entry)}
      {...(DROPPABLE.has(entry) ? dropProps({ folder: entry }, entry) : {})}
    >
      <MailboxFolderIcon name={entry} />
      <span className={styles.label}>{t(entry)}</span>
      {entry === "inbox" ? pill(inboxUnread) : null}
      {entry === "snoozed" ? quiet(schedules?.snoozed ?? 0) : null}
      {entry === "scheduled" ? quiet(schedules?.scheduled ?? 0) : null}
      {entry === "followups" ? pill(schedules?.followUps ?? 0) : null}
    </button>
  );

  return (
    <aside
      ref={rail}
      id="mailbox-folders-navigation"
      className={styles.rail}
      data-expanded={expanded}
      data-mailbox-id={selectedId ?? undefined}
      data-mailbox-scope={selectedId ? "selected" : scope}
      data-folder={folder}
      aria-label={t("organization.boxesAndFolders")}
      onKeyDown={onKeyDown}
    >
      <div className={styles.drawerHeader}>
        <strong>{t("organization.boxesAndFolders")}</strong>
        <button
          type="button"
          className={styles.toolButton}
          data-drawer-close
          aria-label={t("close")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className={styles.scroll}>
        <div className={styles.picker} ref={picker}>
          <div className={styles.pickerHeader}>
            <button
              type="button"
              ref={pickerButton}
              className={styles.pickerTrigger}
              aria-label={`${t("rail.boxes")}: ${selected ? `${selected.label} · ${selected.address}` : t(`scope.boxes.${scope}`)}`}
              title={
                selected ? `${selected.label} · ${selected.address}` : t(`scope.boxes.${scope}`)
              }
              aria-expanded={boxesOpen}
              aria-controls={`${id}-box-picker`}
              onClick={() => {
                if (narrow) applyRailCollapsed(false, false);
                setBoxesOpen((open) => !open);
              }}
            >
              <MailboxFolderIcon name="stack" />
              <span className={`${styles.label} ${styles.pickerIdentity}`}>
                <strong>{selected?.label ?? t(`scope.boxes.${scope}`)}</strong>
                {selected ? <small>{selected.address}</small> : null}
              </span>
              <span className={styles.pickerChevron} aria-hidden="true">
                <MailboxFolderIcon name="chevronDown" />
              </span>
            </button>
            {selected && boxMenu.length ? (
              <span className={styles.selectedMenu}>
                <PopoverMenu
                  ariaLabel={t("rail.boxMenu", { name: selected.label })}
                  items={boxMenu}
                />
              </span>
            ) : null}
          </div>
          {boxesOpen ? (
            <section
              id={`${id}-box-picker`}
              className={`${styles.section} ${styles.pickerPanel}`}
              aria-labelledby={`${id}-boxes`}
              data-mailbox-picker-panel
            >
              <div className={styles.sectionHeader}>
                <h3 id={`${id}-boxes`} className="ms-microlabel">
                  {t("rail.boxes")}
                </h3>
                {boxesMenu.length ? (
                  <PopoverMenu ariaLabel={t("rail.boxesMenu")} items={boxesMenu} />
                ) : null}
              </div>
              {boxes.length > RAIL_SEARCH_THRESHOLD ? (
                <input
                  type="search"
                  className={`ms-input ${styles.search}`}
                  value={query}
                  placeholder={t("rail.searchBoxes")}
                  aria-label={t("rail.searchBoxes")}
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : null}
              <button
                type="button"
                className={styles.item}
                aria-current={!selectedId && scope === "all" ? "page" : undefined}
                data-mailbox-scope="all"
                title={t("scope.boxes.all")}
                onClick={() => {
                  onScope("all");
                  closePicker(true);
                }}
              >
                <MailboxFolderIcon name="stack" />
                <span className={styles.label}>{t("scope.boxes.all")}</span>
              </button>
              {groups.map((group) => (
                <div className={styles.group} key={group.kind}>
                  <button
                    type="button"
                    className={styles.groupHeader}
                    aria-current={!selectedId && scope === group.kind ? "page" : undefined}
                    data-mailbox-scope={group.kind}
                    title={t(`scope.boxes.${group.kind}`)}
                    onClick={() => {
                      onScope(group.kind);
                      closePicker(true);
                    }}
                  >
                    <span className={styles.label}>{t(`scope.${group.kind}`)}</span>
                  </button>
                  {group.boxes.map((box) => (
                    <button
                      type="button"
                      key={box.id}
                      className={styles.item}
                      aria-current={selectedId === box.id ? "page" : undefined}
                      data-mailbox-id={box.id}
                      data-mailbox-kind={box.kind}
                      title={`${box.label} · ${box.address}`}
                      aria-label={`${box.label} · ${box.address}${unread[box.id] ? ` · ${unreadLabel(unread[box.id] ?? 0)}` : ""}`}
                      onClick={() => {
                        onSelectBox(box.id);
                        closePicker(true);
                      }}
                    >
                      <span
                        className={styles.boxInitial}
                        aria-hidden="true"
                        style={{ "--avatar-hue": mailboxAvatarHue(box.address) } as CSSProperties}
                      >
                        {mailboxInitials(box.label, box.address)}
                      </span>
                      <span className={`${styles.label} ${styles.boxIdentity}`}>
                        <span className={styles.boxName}>{box.label}</span>
                        <span className={styles.boxAddress}>{box.address}</span>
                      </span>
                      {pill(unread[box.id] ?? 0)}
                    </button>
                  ))}
                  {group.hidden > 0 ? (
                    <button
                      type="button"
                      className={styles.showAll}
                      onClick={() => setShowAll((current) => ({ ...current, [group.kind]: true }))}
                    >
                      {t("rail.showAll", { count: group.total })}
                    </button>
                  ) : showAll[group.kind] && !query ? (
                    <button
                      type="button"
                      className={styles.showAll}
                      onClick={() => setShowAll((current) => ({ ...current, [group.kind]: false }))}
                    >
                      {t("rail.showFewer")}
                    </button>
                  ) : null}
                </div>
              ))}
              {query && !groups.length ? (
                <p className={styles.empty}>{t("rail.noBoxMatches")}</p>
              ) : null}
            </section>
          ) : null}
        </div>
        <nav className={styles.folders} aria-label={t("folders")}>
          <h3 className={`ms-microlabel ${styles.foldersHeading}`}>{t("folders")}</h3>
          {PRIMARY.map(folderButton)}
          <button
            type="button"
            className={`${styles.item} ${styles.more}`}
            aria-expanded={moreOpen}
            title={t("rail.more")}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span className={styles.chevron}>
              <MailboxFolderIcon name="chevronDown" />
            </span>
            <span className={styles.label}>{t("rail.more")}</span>
          </button>
          {moreOpen ? MORE.map(folderButton) : null}
          {folderButton("trash")}
        </nav>
        <button
          type="button"
          className={`${styles.item} ${styles.collapsedOnly}`}
          title={t("organization.folders")}
          aria-label={t("organization.folders")}
          onClick={() => applyRailCollapsed(false)}
        >
          <MailboxFolderIcon name="custom" />
        </button>
        <div className={styles.custom}>{folders}</div>
        <div className={styles.usage}>{usage}</div>
      </div>
      <div className={styles.footer}>
        <Link
          href="/mail/settings"
          className={styles.toolButton}
          aria-label={t("app.settings")}
          title={t("app.settings")}
        >
          <MailboxFolderIcon name="settings" />
        </Link>
        <MailboxHelpMenu onShortcuts={onShortcuts} />
        <button
          type="button"
          className={`${styles.toolButton} ${styles.collapseToggle}`}
          aria-label={t(narrow ? "rail.expand" : "rail.collapse")}
          title={t(narrow ? "rail.expand" : "rail.collapse")}
          onClick={() => applyRailCollapsed(!narrow)}
        >
          <MailboxFolderIcon name="sidebar" />
        </button>
      </div>
    </aside>
  );
}
