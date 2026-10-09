import { describe, expect, it } from "vitest";
import {
  CORREIO_PREF_DEFAULTS,
  CORREIO_PREFS_PREPAINT_SCRIPT,
  completeCorreioPrefs,
} from "./mailbox-preferences";

describe("completeCorreioPrefs", () => {
  it("fills every field from the defaults", () => {
    expect(completeCorreioPrefs(null)).toEqual(CORREIO_PREF_DEFAULTS);
    expect(completeCorreioPrefs("nonsense")).toEqual(CORREIO_PREF_DEFAULTS);
    expect(completeCorreioPrefs([])).toEqual(CORREIO_PREF_DEFAULTS);
  });

  it("keeps valid values and drops invalid ones field by field", () => {
    const prefs = completeCorreioPrefs({
      theme: "light",
      density: "dense",
      readingPane: "bottom",
      previewLines: 7,
      startFolder: "folder:5d2c8d1e-7f1a-4b0e-9c3d-2a1b3c4d5e6f",
      markSeenAfterMs: 3000,
      showAvatars: "yes",
      unknown: true,
    });
    expect(prefs).toEqual({
      ...CORREIO_PREF_DEFAULTS,
      theme: "light",
      readingPane: "bottom",
      startFolder: "folder:5d2c8d1e-7f1a-4b0e-9c3d-2a1b3c4d5e6f",
      markSeenAfterMs: 3000,
    });
    expect("unknown" in prefs).toBe(false);
  });

  it("accepts null for the manual mark-as-read mode", () => {
    expect(completeCorreioPrefs({ markSeenAfterMs: null }).markSeenAfterMs).toBeNull();
    expect(completeCorreioPrefs({ markSeenAfterMs: 1000 }).markSeenAfterMs).toBe(1500);
  });
});

describe("CORREIO_PREFS_PREPAINT_SCRIPT", () => {
  function run(stored: unknown, lightDevice: boolean) {
    const dataset: Record<string, string> = {};
    const attributes: Record<string, string> = {};
    const root = {
      dataset,
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      removeAttribute: (name: string) => {
        delete attributes[name];
      },
    };
    const sandbox = {
      localStorage: {
        getItem: () => (stored === undefined ? null : JSON.stringify(stored)),
      },
      document: { documentElement: root },
      matchMedia: () => ({ matches: lightDevice }),
    };
    const fn = new Function(
      "localStorage",
      "document",
      "matchMedia",
      CORREIO_PREFS_PREPAINT_SCRIPT,
    );
    fn(sandbox.localStorage, sandbox.document, sandbox.matchMedia);
    return { dataset, attributes };
  }

  it("applies the mirrored layout before paint and the device theme for system", () => {
    const { dataset, attributes } = run(
      { density: "compact", readingPane: "off", previewLines: 2, theme: "system" },
      true,
    );
    expect(dataset).toEqual({ density: "compact", readingPane: "off", previewLines: "2" });
    expect(attributes).toEqual({ "data-theme": "light" });
  });

  it("falls back to the defaults and leaves an explicit theme alone", () => {
    const { dataset, attributes } = run({ theme: "dark", previewLines: 9 }, true);
    expect(dataset).toEqual({ density: "comfortable", readingPane: "right", previewLines: "1" });
    expect(attributes).toEqual({});
  });

  it("applies the rail the person collapsed or expanded on this device", () => {
    const rail = (stored: unknown) => {
      const dataset: Record<string, string> = { rail: "stale" };
      const root = { dataset, setAttribute: () => {}, removeAttribute: () => {} };
      const fn = new Function(
        "localStorage",
        "document",
        "matchMedia",
        CORREIO_PREFS_PREPAINT_SCRIPT,
      );
      fn(
        {
          getItem: (key: string) =>
            key === "mepmail.correio.rail" && stored !== undefined ? JSON.stringify(stored) : null,
        },
        { documentElement: root },
        () => ({ matches: false }),
      );
      return dataset.rail;
    };
    expect(rail({ collapsed: true })).toBe("collapsed");
    expect(rail({ collapsed: false })).toBe("expanded");
    expect(rail({ collapsed: null })).toBeUndefined();
    expect(rail(undefined)).toBeUndefined();
  });

  it("survives a missing or broken mirror", () => {
    expect(() => run(undefined, false)).not.toThrow();
    const fn = new Function(
      "localStorage",
      "document",
      "matchMedia",
      CORREIO_PREFS_PREPAINT_SCRIPT,
    );
    expect(() =>
      fn({ getItem: () => "{broken" }, { documentElement: {} }, () => ({ matches: false })),
    ).not.toThrow();
  });
});
