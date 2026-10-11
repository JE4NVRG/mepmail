import { isDesktop } from "@/lib/desktop-bridge";

/**
 * Desfazer envio: the one send waiting out its undo window. It lives outside
 * the inbox view because that view remounts when the mailbox scope changes
 * (the composer's Send itself switches to the draft's mailbox), and the wait,
 * the countdown and "Desfazer" have to survive it. The view that rendered last
 * registers how to deliver and what to show after an undo.
 */
export type HeldRevision = { mailboxId: string; id: string; expectedRevision: number };
export type HeldSend = { key: string; revision: HeldRevision; deadline: number };

type Handlers = {
  /** The wait is over: the message goes to the server now. */
  deliver: (revision: HeldRevision) => void;
  /** "Desfazer" ran: nothing was sent. */
  undone: (send: HeldSend) => void;
};

let held: { send: HeldSend; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * A page that closes during the wait sends nothing; a marker kept while a send
 * waits lets the next visit say so. Per tab in a browser, so one tab never
 * reads another tab's send as cancelled; across restarts in the desktop app,
 * whose single window can also quit from the tray.
 */
const MARKER_KEY = "mepmail.correio.heldSend";
/** A marker older than this is a leftover, not something to report. */
const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

function markerStore(): Storage | null {
  try {
    return isDesktop() ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function writeMarker(send: HeldSend | null): void {
  try {
    const store = markerStore();
    if (send) store?.setItem(MARKER_KEY, JSON.stringify(send));
    else store?.removeItem(MARKER_KEY);
  } catch {
    // Storage blocked or full: the send itself is unaffected.
  }
}
let handlers: Handlers | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export const heldSendKey = (revision: HeldRevision) =>
  `${revision.mailboxId}:${revision.id}:${revision.expectedRevision}`;

export function subscribeHeldSend(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The send waiting now, or null (a stable object while it waits). */
export function heldSend(): HeldSend | null {
  return held?.send ?? null;
}

export function setHeldSendHandlers(next: Handlers): void {
  handlers = next;
}

/** Holds a send for `ms`. A send already waiting goes now instead of queueing. */
export function holdSend(revision: HeldRevision, ms: number, now = Date.now()): HeldSend {
  releaseHeldSend();
  const send = { key: heldSendKey(revision), revision, deadline: now + ms };
  held = { send, timer: setTimeout(() => releaseHeldSend(send.key), ms) };
  writeMarker(send);
  emit();
  return send;
}

/** Sends the waiting message now; with a key, only if that one is still waiting. */
export function releaseHeldSend(key?: string): void {
  if (!held || (key !== undefined && held.send.key !== key)) return;
  const { send, timer } = held;
  clearTimeout(timer);
  held = null;
  writeMarker(null);
  emit();
  handlers?.deliver(send.revision);
}

/** "Desfazer": drops the waiting send. False when there was none (it already went). */
export function undoHeldSend(): boolean {
  if (!held) return false;
  const { send, timer } = held;
  clearTimeout(timer);
  held = null;
  writeMarker(null);
  emit();
  handlers?.undone(send);
  return true;
}

/**
 * The send a closed page left waiting, once: the page closed (or reloaded)
 * before the wait ended, so it never went. Null while a send waits in this
 * page (a remount, not a reload) and when there is nothing to report.
 */
export function takeInterruptedSend(now = Date.now()): HeldSend | null {
  if (held) return null;
  try {
    const store = markerStore();
    const raw = store?.getItem(MARKER_KEY);
    if (!raw) return null;
    store?.removeItem(MARKER_KEY);
    const send = JSON.parse(raw) as Partial<HeldSend>;
    const revision = send.revision;
    if (
      typeof send.key !== "string" ||
      typeof send.deadline !== "number" ||
      !revision ||
      typeof revision.mailboxId !== "string" ||
      typeof revision.id !== "string" ||
      typeof revision.expectedRevision !== "number" ||
      now - send.deadline > MARKER_TTL_MS
    )
      return null;
    return { key: send.key, revision, deadline: send.deadline };
  } catch {
    return null;
  }
}
