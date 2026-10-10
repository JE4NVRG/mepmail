import { useSyncExternalStore } from "react";
import { CORREIO_COLUMNS_KEY } from "./mailbox-preferences-prepaint";

/**
 * The Correio column widths the person dragged, kept on this device like the
 * rail's collapsed state: [Caixas e pastas] | [Lista] | [Leitura]. A width is
 * only a wish; the CSS clamps it to the window (mailboxes.module.css and
 * mailbox-rail.module.css read the same limits), so a narrow window never
 * overlaps or scrolls sideways and the saved width comes back when it widens.
 */

export const COLUMN_LIMITS = {
  rail: { min: 180, max: 400 },
  list: { min: 260, max: 720 },
} as const;
/** The reader keeps at least this much beside the list. */
export const READER_MIN = 380;
/** Arrow keys move a divider this far; with Shift, the larger step. */
export const COLUMN_STEP = 16;
export const COLUMN_STEP_LARGE = 64;

export type ColumnName = keyof typeof COLUMN_LIMITS;
export type ColumnWidths = Partial<Record<ColumnName, number>>;

const NAMES = Object.keys(COLUMN_LIMITS) as ColumnName[];
const VARS: Record<ColumnName, string> = { rail: "--correio-rail-w", list: "--correio-list-w" };
const FLAGS: Record<ColumnName, "colRail" | "colList"> = { rail: "colRail", list: "colList" };

/** Whole pixels inside each column's limits; anything else is dropped. */
export function cleanColumnWidths(source: unknown): ColumnWidths {
  const input =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const result: ColumnWidths = {};
  for (const name of NAMES) {
    const value = input[name];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = COLUMN_LIMITS[name];
    if (value >= min && value <= max) result[name] = Math.round(value);
  }
  return result;
}

/**
 * How wide a column may be with `space` pixels to share: the rail leaves room
 * for the narrowest list and reader (its space is the whole workspace), the
 * list leaves room for the reader (its space is the list plus the reader).
 */
export function columnBounds(name: ColumnName, space: number): { min: number; max: number } {
  const { min, max } = COLUMN_LIMITS[name];
  const reserve = name === "rail" ? COLUMN_LIMITS.list.min + READER_MIN : READER_MIN;
  return { min, max: Math.max(min, Math.min(max, Math.floor(space - reserve))) };
}

export function clampColumn(name: ColumnName, width: number, space: number): number {
  const { min, max } = columnBounds(name, space);
  return Math.round(Math.min(max, Math.max(min, width)));
}

export function readColumnWidths(): ColumnWidths {
  try {
    return cleanColumnWidths(
      JSON.parse(window.localStorage.getItem(CORREIO_COLUMNS_KEY) ?? "null"),
    );
  } catch {
    return {};
  }
}

/** The widths on <html> for the CSS: a variable and a flag per dragged column. */
export function applyColumnWidths(widths: ColumnWidths): void {
  const root = document.documentElement;
  for (const name of NAMES) {
    const width = widths[name];
    if (width === undefined) {
      root.style.removeProperty(VARS[name]);
      delete root.dataset[FLAGS[name]];
    } else {
      root.style.setProperty(VARS[name], `${width}px`);
      root.dataset[FLAGS[name]] = "1";
    }
  }
}

const listeners = new Set<() => void>();
let snapshot: ColumnWidths | null = null;
let snapshotKey = "";

/** Saves on this device (or forgets, for a column left out) and applies at once. */
export function saveColumnWidths(widths: ColumnWidths): void {
  const clean = cleanColumnWidths(widths);
  applyColumnWidths(clean);
  try {
    if (Object.keys(clean).length)
      window.localStorage.setItem(CORREIO_COLUMNS_KEY, JSON.stringify(clean));
    else window.localStorage.removeItem(CORREIO_COLUMNS_KEY);
  } catch {
    // Storage may be unavailable; the widths still hold for this page.
  }
  snapshot = clean;
  snapshotKey = JSON.stringify(clean);
  for (const listener of listeners) listener();
}

/** "Restaurar larguras padrão": only the widths; every other preference stays. */
export function resetColumnWidths(): void {
  saveColumnWidths({});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CORREIO_COLUMNS_KEY) return;
    applyColumnWidths(readColumnWidths());
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function current(): ColumnWidths {
  const fresh = readColumnWidths();
  const key = JSON.stringify(fresh);
  if (!snapshot || key !== snapshotKey) {
    snapshot = fresh;
    snapshotKey = key;
  }
  return snapshot;
}

const EMPTY: ColumnWidths = {};

/** The saved widths, kept current across components and other tabs. */
export function useColumnWidths(): ColumnWidths {
  return useSyncExternalStore(subscribe, current, () => EMPTY);
}
