"use client";

import { useEffect, useRef } from "react";

/**
 * Live updates for the Correio: one EventSource to /api/mailboxes/events
 * (server-sent "arrival" events, ids only). Arrivals close together are
 * handled once; the page is told through a window event so every list
 * refreshes at once. Polling stays as the safety net when the stream is down.
 */
export const MAILBOX_ARRIVAL_EVENT = "mepmail:arrival";
/** A new message worth showing while the Correio is in use (detail: NewMailNotice). */
export const MAILBOX_NEW_MAIL_EVENT = "mepmail:new-mail";

const BATCH_MS = 400;

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
    source.addEventListener("arrival", (event) => {
      const mailboxId = arrivalMailboxId((event as MessageEvent<string>).data);
      if (!mailboxId) return;
      pending.add(mailboxId);
      timer ??= setTimeout(flush, BATCH_MS);
    });
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
