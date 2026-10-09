import { CORREIO_RAIL_KEY } from "./mailbox-preferences-prepaint";

/**
 * The Correio side rail: mailboxes grouped by use, and the rail's own state on
 * this device (collapsed to icons or expanded).
 */

export type MailboxRailKind = "person" | "agent";
export type MailboxRailBox = { id: string; label: string; address: string; kind: MailboxRailKind };

/** A group shows this many mailboxes until "Show all". */
export const RAIL_GROUP_LIMIT = 8;
/** Past this many mailboxes the rail offers a search field. */
export const RAIL_SEARCH_THRESHOLD = 10;

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/**
 * People first, then agents; empty groups are left out. A query matches the
 * label or the address, ignoring case and accents, and shows every match. The
 * selected mailbox stays visible even past the group limit.
 */
export function mailboxRailGroups<B extends MailboxRailBox>(
  boxes: readonly B[],
  options: {
    query?: string;
    expanded?: Partial<Record<MailboxRailKind, boolean>>;
    selectedId?: string | null;
  } = {},
): { kind: MailboxRailKind; boxes: B[]; total: number; hidden: number }[] {
  const query = fold(options.query?.trim() ?? "");
  return (["person", "agent"] as const)
    .map((kind) => {
      const all = boxes.filter(
        (box) =>
          box.kind === kind && (!query || fold(`${box.label} ${box.address}`).includes(query)),
      );
      if (query || options.expanded?.[kind] || all.length <= RAIL_GROUP_LIMIT)
        return { kind, boxes: all, total: all.length, hidden: 0 };
      const shown = all.slice(0, RAIL_GROUP_LIMIT);
      const selected = all.find((box) => box.id === options.selectedId);
      if (selected && !shown.includes(selected)) shown.push(selected);
      return { kind, boxes: shown, total: all.length, hidden: all.length - shown.length };
    })
    .filter((group) => group.total > 0);
}

/** null = follow the window width (icons only between 850 and 1050 px). */
export type MailboxRailCollapsed = boolean | null;

export function readRailCollapsed(): MailboxRailCollapsed {
  try {
    const value = JSON.parse(window.localStorage.getItem(CORREIO_RAIL_KEY) ?? "null") as {
      collapsed?: unknown;
    } | null;
    return typeof value?.collapsed === "boolean" ? value.collapsed : null;
  } catch {
    return null;
  }
}

/** Saves the choice on this device and applies it to <html> for the CSS. */
export function applyRailCollapsed(collapsed: MailboxRailCollapsed, save = true): void {
  const root = document.documentElement;
  if (collapsed === null) delete root.dataset.rail;
  else root.dataset.rail = collapsed ? "collapsed" : "expanded";
  if (!save) return;
  try {
    window.localStorage.setItem(CORREIO_RAIL_KEY, JSON.stringify({ collapsed }));
  } catch {
    // Storage may be unavailable; the choice still holds for this page.
  }
}
