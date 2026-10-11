"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Live updates for the Correio: one EventSource to /api/mailboxes/events
 * (server-sent "arrival" events, ids only). Arrivals close together are
 * handled once; the page is told through a window event so every list
 * refreshes at once. Polling stays as the safety net when the stream is down.
 */
export const MAILBOX_ARRIVAL_EVENT = "mepmail:arrival";
/** A new message worth showing while the Correio is in use (detail: NewMailNotice). */
export const MAILBOX_NEW_MAIL_EVENT = "mepmail:new-mail";
/**
 * Messages the person just marked unread here (detail: "mailboxId:id" keys):
 * the unread count grows, but they are not new mail to announce.
 */
export const MAILBOX_MARKED_UNREAD_EVENT = "mepmail:marked-unread";

const BATCH_MS = 400;

/**
 * Whether the live stream is up. While it is, arrivals come through it and
 * the polls are only a safety net, so they slow down (each list poll costs the
 * server one decryption per message); when it drops, they speed up again.
 */
let connected = false;
const statusListeners = new Set<() => void>();
function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  for (const listener of statusListeners) listener();
}
const subscribeStatus = (listener: () => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};
export function useMailboxLiveConnected(): boolean {
  return useSyncExternalStore(
    subscribeStatus,
    () => connected,
    () => false,
  );
}
/** A safety-net poll interval: `fallbackMs` without the stream, a minute with it. */
export function livePollMs(live: boolean, fallbackMs: number): number {
  return live ? Math.max(fallbackMs, 60_000) : fallbackMs;
}

/** The mailbox id an "arrival" event carries, or null. */
export function arrivalMailboxId(data: string): string | null {
  try {
    const value = JSON.parse(data) as { mailboxId?: unknown };
    return typeof value.mailboxId === "string" ? value.mailboxId : null;
  } catch {
    return null;
  }
}

export function useMailboxLive(enabled: boolean, onArrival: (mailboxIds: string[]) => void) {
  const handler = useRef(onArrival);
  handler.current = onArrival;
  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const mailboxIds = [...pending];
      pending = new Set();
      handler.current(mailboxIds);
      window.dispatchEvent(new CustomEvent(MAILBOX_ARRIVAL_EVENT, { detail: { mailboxIds } }));
    };
    const source = new EventSource("/api/mailboxes/events");
    // The stream renews itself every few minutes and after a network blip;
    // whatever arrived in that gap is read on reconnect, not at the next poll.
    let opened = false;
    source.addEventListener("error", () => setConnected(false));
    source.addEventListener("open", () => {
      setConnected(true);
      if (opened) {
        handler.current([]);
        window.dispatchEvent(
          new CustomEvent(MAILBOX_ARRIVAL_EVENT, { detail: { mailboxIds: [] } }),
        );
      }
      opened = true;
    });
    source.addEventListener("arrival", (event) => {
      const mailboxId = arrivalMailboxId((event as MessageEvent<string>).data);
      if (!mailboxId) return;
      pending.add(mailboxId);
      timer ??= setTimeout(flush, BATCH_MS);
    });
    return () => {
      source.close();
      setConnected(false);
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
