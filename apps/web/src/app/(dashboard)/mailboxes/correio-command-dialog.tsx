"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MailboxFolder } from "@/lib/mailbox-inbox-presentation";
import type { CorreioPrefs } from "@/lib/mailbox-preferences";
import styles from "./mailboxes.module.css";

type CorreioTheme = CorreioPrefs["theme"];

type CommandBox = {
  id: string;
  label: string;
  address: string;
  kind: "person" | "agent";
};

type CommandEntry = {
  id: string;
  group: "actions" | "folders" | "mailboxes";
  label: string;
  meta?: string;
  badge?: string;
  run: () => void;
};

const QUICK_FOLDERS: MailboxFolder[] = [
  "inbox",
  "sent",
  "drafts",
  "favorites",
  "snoozed",
  "scheduled",
  "followups",
  "archive",
  "trash",
];

const NEXT_THEME: Record<CorreioTheme, CorreioTheme> = {
  dark: "light",
  light: "system",
  system: "dark",
};

/**
 * Quick keyboard-first command palette inside Correio: jump between human and
 * agent mailboxes, switch folders, compose, or open agent settings in seconds.
 */
export function CorreioCommandDialog({
  close,
  boxes,
  theme,
  onToggleTheme,
  canCompose,
  onCompose,
  onSelectFolder,
  onSelectBox,
  onScopeAll,
  onOpenAgents,
  onOpenSettings,
  onOpenShortcuts,
}: {
  close: () => void;
  boxes: readonly CommandBox[];
  theme: CorreioTheme;
  onToggleTheme: (next: CorreioTheme) => void;
  canCompose: boolean;
  onCompose: () => void;
  onSelectFolder: (folder: MailboxFolder) => void;
  onSelectBox?: ((id: string) => void) | undefined;
  onScopeAll?: (() => void) | undefined;
  onOpenAgents?: (() => void) | undefined;
  onOpenSettings?: (() => void) | undefined;
  onOpenShortcuts: () => void;
}) {
  const t = useTranslations("mailboxes");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    input.current?.focus();
  }, []);

  const entries = useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [];
    if (canCompose) {
      list.push({
        id: "action:compose",
        group: "actions",
        label: t("commands.items.compose"),
        meta: "C",
        run: onCompose,
      });
    }
    if (onOpenAgents) {
      list.push({
        id: "action:agents",
        group: "actions",
        label: t("commands.items.agents"),
        badge: t("rail.agentBadge"),
        run: onOpenAgents,
      });
    }
    if (onOpenSettings) {
      list.push({
        id: "action:settings",
        group: "actions",
        label: t("commands.items.settings"),
        run: onOpenSettings,
      });
    }
    list.push({
      id: "action:theme",
      group: "actions",
      label: t("commands.items.theme"),
      meta: t(
        `appearance.${theme === "light" ? "themeLight" : theme === "dark" ? "themeDark" : "themeSystem"}`,
      ),
      run: () => onToggleTheme(NEXT_THEME[theme]),
    });
    list.push({
      id: "action:shortcuts",
      group: "actions",
      label: t("commands.items.shortcuts"),
      meta: "?",
      run: onOpenShortcuts,
    });
    for (const folder of QUICK_FOLDERS) {
      list.push({
        id: `folder:${folder}`,
        group: "folders",
        label: t(folder),
        run: () => onSelectFolder(folder),
      });
    }
    if (onScopeAll) {
      list.push({
        id: "box:all",
        group: "mailboxes",
        label: t("scope.boxes.all"),
        run: onScopeAll,
      });
    }
    if (onSelectBox) {
      for (const box of boxes) {
        list.push({
          id: `box:${box.id}`,
          group: "mailboxes",
          label: box.label,
          meta: box.address,
          ...(box.kind === "agent" ? { badge: t("rail.agentBadge") } : {}),
          run: () => onSelectBox(box.id),
        });
      }
    }
    return list;
  }, [
    boxes,
    canCompose,
    onCompose,
    onOpenAgents,
    onOpenSettings,
    onOpenShortcuts,
    onScopeAll,
    onSelectBox,
    onSelectFolder,
    onToggleTheme,
    t,
    theme,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice(0, 24);
    return entries
      .filter(
        (entry) =>
          entry.label.toLowerCase().includes(q) ||
          (entry.meta?.toLowerCase().includes(q) ?? false) ||
          (entry.badge?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 30);
  }, [entries, query]);

  const activeIndex = filtered.length ? Math.min(cursor, filtered.length - 1) : -1;
  const groups = (["actions", "folders", "mailboxes"] as const)
    .map((group) => ({
      group,
      items: filtered.filter((item) => item.group === group),
    }))
    .filter((section) => section.items.length > 0);

  const runEntry = (entry: CommandEntry | undefined) => {
    if (!entry) return;
    dialog.current?.close();
    entry.run();
  };

  return (
    <dialog
      ref={dialog}
      aria-modal="true"
      className={`${styles.dialog} ${styles.commandDialog}`}
      aria-label={t("commands.title")}
      onClose={close}
    >
      <div className={styles.commandSearchWrap}>
        <input
          ref={input}
          type="search"
          value={query}
          placeholder={t("commands.placeholder")}
          aria-label={t("commands.placeholder")}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (!filtered.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => (c + 1) % filtered.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => (c - 1 + filtered.length) % filtered.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              runEntry(filtered[activeIndex]);
            }
          }}
        />
        <button
          type="button"
          className="ms-btn ms-btn-ghost ms-btn-sm"
          aria-label={t("shortcuts.close")}
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </div>
      <div className={styles.commandList} role="listbox" aria-label={t("commands.title")}>
        {!groups.length ? (
          <p className={styles.commandEmpty}>{t("commands.empty")}</p>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group}>
              <p className={styles.commandGroupLabel}>{t(`commands.groups.${group}`)}</p>
              {items.map((entry) => {
                const index = filtered.indexOf(entry);
                const selected = index === activeIndex;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={styles.commandItem}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => runEntry(entry)}
                  >
                    <span>{entry.label}</span>
                    <span className={styles.commandItemMeta}>
                      {entry.badge ? (
                        <span className={styles.commandBadge}>{entry.badge}</span>
                      ) : null}
                      {entry.meta ? <span className="ms-mono">{entry.meta}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </dialog>
  );
}
