"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CORREIO_PREFS_KEY } from "./mailbox-preferences-prepaint";
import { quickRepliesSchema, type UndoSendSeconds, undoSendSchema } from "./mailbox-quick-replies";
import { applyTheme } from "./theme";
import { useTRPC } from "./trpc";

/**
 * How one person likes the Correio inbox: the server keeps the preferences
 * per user (`mailboxes.preferences`), so they follow the person across the
 * web, the desktop shell and, later, the phone. This module mirrors the
 * server's fields and defaults, keeps a local copy for the first paint, and
 * writes changes back with a short debounce.
 */

export { CORREIO_PREFS_KEY, CORREIO_PREFS_PREPAINT_SCRIPT } from "./mailbox-preferences-prepaint";

const FIELDS = {
  theme: z.enum(["system", "light", "dark"]),
  density: z.enum(["comfortable", "compact"]),
  readingPane: z.enum(["right", "bottom", "off"]),
  previewLines: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  groupByThread: z.boolean(),
  startFolder: z.union([
    z.enum(["inbox", "favorites", "drafts", "sent", "archive", "trash"]),
    z.string().regex(/^folder:[0-9a-f-]{36}$/),
  ]),
  showAvatars: z.boolean(),
  markSeenAfterMs: z.union([z.literal(0), z.literal(1500), z.literal(3000), z.null()]),
  showShortcutHints: z.boolean(),
  undoSendSeconds: undoSendSchema,
  quickReplies: quickRepliesSchema,
  smartInbox: z.boolean(),
};

export type CorreioPrefs = {
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  readingPane: "right" | "bottom" | "off";
  previewLines: 0 | 1 | 2;
  groupByThread: boolean;
  startFolder: "inbox" | "favorites" | "drafts" | "sent" | "archive" | "trash" | `folder:${string}`;
  showAvatars: boolean;
  markSeenAfterMs: 0 | 1500 | 3000 | null;
  showShortcutHints: boolean;
  /** Seconds Send waits for "Desfazer"; 0 sends at once. */
  undoSendSeconds: UndoSendSeconds;
  /** The person's own quick replies, or null for the built-in set. */
  quickReplies: string[] | null;
  /** Caixa inteligente: the Inbox split into Pessoas, Notificações and Newsletters. */
  smartInbox: boolean;
};

export const CORREIO_PREF_DEFAULTS: CorreioPrefs = {
  theme: "system",
  density: "comfortable",
  readingPane: "right",
  previewLines: 1,
  groupByThread: true,
  startFolder: "inbox",
  showAvatars: true,
  markSeenAfterMs: 1500,
  showShortcutHints: true,
  undoSendSeconds: 10,
  quickReplies: null,
  smartInbox: true,
};

type Field = keyof CorreioPrefs;
const FIELD_NAMES = Object.keys(FIELDS) as Field[];

/** Every field, each valid; anything missing or invalid takes the default. */
export function completeCorreioPrefs(source: unknown): CorreioPrefs {
  const input =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = { ...CORREIO_PREF_DEFAULTS };
  for (const field of FIELD_NAMES) {
    if (!Object.hasOwn(input, field)) continue;
    const parsed = FIELDS[field].safeParse(input[field]);
    if (parsed.success) result[field] = parsed.data;
  }
  return result as CorreioPrefs;
}

/** The locally mirrored preferences, or the defaults when nothing was saved. */
export function readLocalCorreioPrefs(): CorreioPrefs {
  try {
    const raw = window.localStorage.getItem(CORREIO_PREFS_KEY);
    return completeCorreioPrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...CORREIO_PREF_DEFAULTS };
  }
}

function writeLocalCorreioPrefs(prefs: CorreioPrefs): void {
  try {
    window.localStorage.setItem(CORREIO_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable; the server copy is the one that matters.
  }
}

/** The attributes the CSS reads, applied to <html> so they survive remounts. */
export function applyCorreioLayout(
  prefs: Pick<CorreioPrefs, "density" | "readingPane" | "previewLines" | "showAvatars">,
): void {
  const root = document.documentElement;
  root.dataset.density = prefs.density;
  root.dataset.readingPane = prefs.readingPane;
  root.dataset.previewLines = String(prefs.previewLines);
  if (prefs.showAvatars) delete root.dataset.avatars;
  else root.dataset.avatars = "off";
}

/**
 * The Correio theme. Light and dark use the account toggle (so the dashboard
 * follows); "system" follows the device only while a Correio page is open and
 * never writes the account toggle.
 */
export function applyCorreioTheme(theme: CorreioPrefs["theme"]): () => void {
  if (theme !== "system") {
    applyTheme(theme);
    return () => {};
  }
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const follow = () => {
    if (media.matches) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  };
  follow();
  media.addEventListener("change", follow);
  return () => media.removeEventListener("change", follow);
}

const DEBOUNCE_MS = 400;

/**
 * The preferences as the page should show them, plus `setPref` to change
 * one or more fields: the UI updates at once, the server is written after a
 * short pause, and its answer (the complete object) replaces the local copy.
 */
export function useCorreioPrefs(): {
  prefs: CorreioPrefs;
  loaded: boolean;
  setPref: (patch: Partial<CorreioPrefs>) => void;
  resetPrefs: () => void;
} {
  const trpc = useTRPC();
  const queries = useQueryClient();
  const query = useQuery(
    trpc.mailboxes.preferences.get.queryOptions(undefined, {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    }),
  );
  const save = useMutation(trpc.mailboxes.preferences.set.mutationOptions({ retry: 1 }));
  const [local, setLocal] = useState<CorreioPrefs>(() =>
    typeof window === "undefined" ? { ...CORREIO_PREF_DEFAULTS } : readLocalCorreioPrefs(),
  );
  const [overrides, setOverrides] = useState<Partial<CorreioPrefs>>({});
  const pending = useRef<Partial<CorreioPrefs>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The server copy wins over the mirror once it arrives.
  useEffect(() => {
    if (!query.data) return;
    const next = completeCorreioPrefs(query.data);
    setLocal(next);
    writeLocalCorreioPrefs(next);
  }, [query.data]);

  const flush = useCallback(() => {
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    save
      .mutateAsync(patch)
      .then((saved) => {
        const next = completeCorreioPrefs(saved);
        queries.setQueryData(trpc.mailboxes.preferences.get.queryKey(), saved);
        setLocal(next);
        writeLocalCorreioPrefs(next);
        setOverrides((current) => {
          const rest = { ...current };
          for (const key of Object.keys(patch) as Field[]) delete rest[key];
          return rest;
        });
      })
      .catch(() => {
        // The change did not reach the server: drop the optimistic value.
        setOverrides((current) => {
          const rest = { ...current };
          for (const key of Object.keys(patch) as Field[]) delete rest[key];
          return rest;
        });
      });
  }, [save, queries, trpc]);

  const setPref = useCallback(
    (patch: Partial<CorreioPrefs>) => {
      const valid = completeCorreioPrefs({ ...CORREIO_PREF_DEFAULTS, ...patch });
      const clean: Partial<CorreioPrefs> = {};
      for (const key of Object.keys(patch) as Field[]) {
        (clean as Record<string, unknown>)[key] = valid[key];
      }
      setOverrides((current) => ({ ...current, ...clean }));
      pending.current = { ...pending.current, ...clean };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush],
  );

  // "Restaurar padrão" is about how the inbox looks and behaves: the quick
  // replies the person wrote stay.
  const resetPrefs = useCallback(() => {
    const { quickReplies: _kept, ...defaults } = CORREIO_PREF_DEFAULTS;
    setPref(defaults);
  }, [setPref]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    [flush],
  );

  const prefs = { ...local, ...overrides } as CorreioPrefs;
  const { density, readingPane, previewLines, showAvatars } = prefs;
  useEffect(() => {
    applyCorreioLayout({ density, readingPane, previewLines, showAvatars });
  }, [density, readingPane, previewLines, showAvatars]);
  return { prefs, loaded: !!query.data || query.isError, setPref, resetPrefs };
}
