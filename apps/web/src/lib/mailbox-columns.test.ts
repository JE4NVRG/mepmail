import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLUMN_LIMITS,
  clampColumn,
  cleanColumnWidths,
  columnBounds,
  READER_MIN,
  readColumnWidths,
  resetColumnWidths,
  saveColumnWidths,
} from "./mailbox-columns";
import {
  CORREIO_COLUMNS_KEY,
  CORREIO_PREFS_KEY,
  CORREIO_PREFS_PREPAINT_SCRIPT,
} from "./mailbox-preferences-prepaint";

function fakeRoot() {
  const style: Record<string, string> = {};
  return {
    dataset: {} as Record<string, string>,
    style: {
      values: style,
      setProperty: (name: string, value: string) => {
        style[name] = value;
      },
      removeProperty: (name: string) => {
        delete style[name];
      },
    },
    setAttribute: () => {},
    removeAttribute: () => {},
  };
}

describe("column limits", () => {
  it("keeps whole pixels inside each column's limits and drops the rest", () => {
    expect(cleanColumnWidths({ rail: 250.4, list: 512 })).toEqual({ rail: 250, list: 512 });
    expect(cleanColumnWidths({ rail: 90, list: 5000 })).toEqual({});
    expect(cleanColumnWidths({ rail: "300", list: Number.NaN, other: 300 })).toEqual({});
    expect(cleanColumnWidths(null)).toEqual({});
    expect(cleanColumnWidths([300])).toEqual({});
  });

  it("leaves the narrowest list and reader their room", () => {
    // A wide window: the column's own maximum.
    expect(columnBounds("rail", 2400)).toEqual({ min: 180, max: COLUMN_LIMITS.rail.max });
    expect(columnBounds("list", 2000)).toEqual({ min: 260, max: COLUMN_LIMITS.list.max });
    // Narrower: the rail keeps list + reader, the list keeps the reader.
    expect(columnBounds("rail", 900)).toEqual({
      min: 180,
      max: 900 - COLUMN_LIMITS.list.min - READER_MIN,
    });
    expect(columnBounds("list", 800)).toEqual({ min: 260, max: 800 - READER_MIN });
    // Too narrow for both: the minimum, never a maximum below it.
    expect(columnBounds("list", 400)).toEqual({ min: 260, max: 260 });
    expect(clampColumn("list", 900, 1100)).toBe(720);
    expect(clampColumn("list", 100, 1100)).toBe(260);
    expect(clampColumn("rail", 333.6, 2000)).toBe(334);
  });
});

describe("saved widths", () => {
  const storage = new Map<string, string>();
  let root: ReturnType<typeof fakeRoot>;
  beforeEach(() => {
    storage.clear();
    root = fakeRoot();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", { documentElement: root });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves on this device and applies the variables the CSS reads", () => {
    saveColumnWidths({ rail: 280, list: 455 });
    expect(JSON.parse(storage.get(CORREIO_COLUMNS_KEY) ?? "{}")).toEqual({ rail: 280, list: 455 });
    expect(root.style.values).toEqual({ "--correio-rail-w": "280px", "--correio-list-w": "455px" });
    expect(root.dataset).toEqual({ colRail: "1", colList: "1" });
    expect(readColumnWidths()).toEqual({ rail: 280, list: 455 });
    // One column back to its default; the other stays.
    saveColumnWidths({ list: 455 });
    expect(root.style.values).toEqual({ "--correio-list-w": "455px" });
    expect(root.dataset).toEqual({ colList: "1" });
  });

  it("restores the default widths and touches no other preference", () => {
    storage.set(CORREIO_PREFS_KEY, JSON.stringify({ density: "compact", readingPane: "bottom" }));
    saveColumnWidths({ rail: 300 });
    resetColumnWidths();
    expect(storage.has(CORREIO_COLUMNS_KEY)).toBe(false);
    expect(storage.get(CORREIO_PREFS_KEY)).toBe(
      JSON.stringify({ density: "compact", readingPane: "bottom" }),
    );
    expect(root.style.values).toEqual({});
    expect(root.dataset).toEqual({});
  });

  it("reads a missing, broken or out-of-range copy as no widths", () => {
    expect(readColumnWidths()).toEqual({});
    storage.set(CORREIO_COLUMNS_KEY, "{broken");
    expect(readColumnWidths()).toEqual({});
    storage.set(CORREIO_COLUMNS_KEY, JSON.stringify({ rail: 9999, list: 300 }));
    expect(readColumnWidths()).toEqual({ list: 300 });
  });
});

describe("column widths before the first paint", () => {
  function prepaint(columns: string | null) {
    const root = fakeRoot();
    const fn = new Function(
      "localStorage",
      "document",
      "matchMedia",
      CORREIO_PREFS_PREPAINT_SCRIPT,
    );
    fn(
      {
        getItem: (key: string) =>
          key === CORREIO_COLUMNS_KEY
            ? columns
            : key === CORREIO_PREFS_KEY
              ? JSON.stringify({ readingPane: "right" })
              : null,
      },
      { documentElement: root },
      () => ({ matches: false }),
    );
    return root;
  }

  it("applies the widths dragged on this device, within the same limits", () => {
    const root = prepaint(JSON.stringify({ rail: 260, list: 500 }));
    expect(root.style.values).toEqual({ "--correio-rail-w": "260px", "--correio-list-w": "500px" });
    expect(root.dataset).toMatchObject({ readingPane: "right", colRail: "1", colList: "1" });
    for (const [name, { min, max }] of Object.entries(COLUMN_LIMITS)) {
      expect(prepaint(JSON.stringify({ [name]: min })).style.values).not.toEqual({});
      expect(prepaint(JSON.stringify({ [name]: max })).style.values).not.toEqual({});
      expect(prepaint(JSON.stringify({ [name]: min - 1 })).style.values).toEqual({});
      expect(prepaint(JSON.stringify({ [name]: max + 1 })).style.values).toEqual({});
    }
  });

  it("keeps the defaults for nothing saved or a broken copy, without breaking the rest", () => {
    for (const stored of [null, "{broken", "null", JSON.stringify({ rail: "wide" })]) {
      const root = prepaint(stored);
      expect(root.style.values).toEqual({});
      expect(root.dataset.colRail).toBeUndefined();
      expect(root.dataset.readingPane).toBe("right");
    }
  });
});
