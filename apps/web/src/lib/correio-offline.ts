import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { isDesktop } from "./desktop-bridge";

/**
 * Reading the Correio without internet, in the desktop app (Jean, 2026-10-11). Two
 * copies, both on this computer and in this person's profile only:
 * - the page and the build's files, kept by the service worker (public/correio-sw.js),
 *   which answers only when the network does not;
 * - the mail the Correio showed (lists, counters, opened messages and the newest
 *   messages of the inbox), kept here in IndexedDB and put back when the app opens.
 * It is per device (a localStorage switch, on by default in the app) and is deleted
 * when it is turned off or the person signs out.
 */

const SWITCH_KEY = "mepmail.correio.offline";
const DB_NAME = "mepmail-correio-offline";
const STORE = "snapshot";
const SNAPSHOT_KEY = "current";
/** Opened messages kept, newest first. */
export const CORREIO_OFFLINE_MESSAGE_LIMIT = 300;
/** A copy older than this is not put back. */
const MAX_AGE_MS = 30 * 86_400_000;

export interface CorreioOfflineSnapshot {
  /** The signed-in person; another account never sees this copy. */
  userId: string;
  savedAt: number;
  state: DehydratedState;
}

/** The desktop app, with the switch not turned off on this device. */
export function correioOfflineWanted(): boolean {
  if (typeof window === "undefined" || !isDesktop()) return false;
  try {
    return window.localStorage.getItem(SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setCorreioOfflineSwitch(on: boolean) {
  try {
    window.localStorage.setItem(SWITCH_KEY, on ? "on" : "off");
  } catch {
    // private storage: the default (on) stays
  }
}

/** Registers the service worker for the Correio's pages. */
export async function startCorreioOffline(scope = "/mail"): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register("/correio-sw.js", { scope });
    return true;
  } catch {
    return false;
  }
}

/** Removes both copies: the service worker's caches and the saved mail. */
export async function clearCorreioOffline(): Promise<void> {
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    for (const registration of registrations)
      if (registration.active?.scriptURL.endsWith("/correio-sw.js")) {
        registration.active.postMessage({ type: "correio-offline-clear" });
        await registration.unregister();
      }
    if ("caches" in window)
      for (const key of await caches.keys())
        if (key.startsWith("correio-")) await caches.delete(key);
  } catch {
    // nothing kept, or not allowed here
  }
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** A Correio query (tRPC key ["mailboxes", …]) worth keeping: answered, with data. */
export function isCorreioOfflineQuery(query: Pick<Query, "queryKey" | "state">): boolean {
  const path = query.queryKey[0];
  return (
    Array.isArray(path) &&
    path[0] === "mailboxes" &&
    query.state.status === "success" &&
    query.state.data !== undefined &&
    // Never credentials or billing: only what the inbox shows.
    !["agentKeys", "teamAgentKeys", "billing", "checkout", "migration", "grants"].includes(
      String(path[1]),
    )
  );
}

const isMessage = (query: Pick<Query, "queryKey">) => {
  const path = query.queryKey[0];
  return Array.isArray(path) && path[0] === "mailboxes" && path[1] === "item";
};

/** The copy to save now: the Correio's queries, opened messages capped (newest first). */
export function correioOfflineState(queryClient: QueryClient): DehydratedState {
  const messages = queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => isMessage(query) && isCorreioOfflineQuery(query))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, CORREIO_OFFLINE_MESSAGE_LIMIT);
  const keep = new Set(messages.map((query) => query.queryHash));
  return dehydrate(queryClient, {
    shouldDehydrateQuery: (query) =>
      isCorreioOfflineQuery(query) && (!isMessage(query) || keep.has(query.queryHash)),
  });
}

export async function saveCorreioOffline(
  queryClient: QueryClient,
  userId: string,
  now = Date.now(),
) {
  const snapshot: CorreioOfflineSnapshot = {
    userId,
    savedAt: now,
    state: correioOfflineState(queryClient),
  };
  await withStore("readwrite", (store) => store.put(snapshot, SNAPSHOT_KEY));
  return snapshot.savedAt;
}

/**
 * Puts the saved copy back (newer answers already in the cache win). With `userId`, only
 * that person's copy; with null (opened without network, so the session cannot be read),
 * the copy of whoever used this computer last: signing out deletes it.
 * Returns when it was saved, or null when there is none to put back.
 */
export async function restoreCorreioOffline(
  queryClient: QueryClient,
  userId: string | null,
  now = Date.now(),
): Promise<number | null> {
  const snapshot = await withStore<CorreioOfflineSnapshot | undefined>("readonly", (store) =>
    store.get(SNAPSHOT_KEY),
  );
  if (!snapshot || (userId !== null && snapshot.userId !== userId)) return null;
  if (now - snapshot.savedAt > MAX_AGE_MS) return null;
  hydrate(queryClient, snapshot.state);
  return snapshot.savedAt;
}
