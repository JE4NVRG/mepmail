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
  emit();
  return send;
}

/** Sends the waiting message now; with a key, only if that one is still waiting. */
export function releaseHeldSend(key?: string): void {
  if (!held || (key !== undefined && held.send.key !== key)) return;
  const { send, timer } = held;
  clearTimeout(timer);
  held = null;
  emit();
  handlers?.deliver(send.revision);
}

/** "Desfazer": drops the waiting send. False when there was none (it already went). */
export function undoHeldSend(): boolean {
  if (!held) return false;
  const { send, timer } = held;
  clearTimeout(timer);
  held = null;
  emit();
  handlers?.undone(send);
  return true;
}
