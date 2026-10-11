import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  heldSend,
  holdSend,
  releaseHeldSend,
  setHeldSendHandlers,
  subscribeHeldSend,
  takeInterruptedSend,
  undoHeldSend,
} from "./mailbox-undo-send";

const draft = (id: string, expectedRevision = 1) => ({ mailboxId: "box", id, expectedRevision });

describe("undo send", () => {
  const deliver = vi.fn();
  const undone = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    deliver.mockReset();
    undone.mockReset();
    setHeldSendHandlers({ deliver, undone });
  });
  afterEach(() => {
    undoHeldSend();
    vi.useRealTimers();
  });

  it("sends once the wait is over, not before", () => {
    const changes = vi.fn();
    const stop = subscribeHeldSend(changes);
    const send = holdSend(draft("a"), 10_000, 1_000);
    expect(send).toEqual({ key: "box:a:1", revision: draft("a"), deadline: 11_000 });
    expect(heldSend()).toBe(send);
    vi.advanceTimersByTime(9_999);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(draft("a"));
    expect(heldSend()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(2);
    stop();
  });

  it("undo keeps the message from going and reports it", () => {
    holdSend(draft("a"), 10_000);
    vi.advanceTimersByTime(4_000);
    expect(undoHeldSend()).toBe(true);
    expect(undone).toHaveBeenCalledWith(expect.objectContaining({ key: "box:a:1" }));
    vi.advanceTimersByTime(20_000);
    expect(deliver).not.toHaveBeenCalled();
    // Too late: nothing is waiting any more.
    expect(undoHeldSend()).toBe(false);
  });

  it("a second send lets the first one go at once instead of dropping it", () => {
    holdSend(draft("a"), 10_000);
    holdSend(draft("b"), 10_000);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(draft("a"));
    expect(heldSend()?.key).toBe("box:b:1");
    vi.advanceTimersByTime(10_000);
    expect(deliver).toHaveBeenLastCalledWith(draft("b"));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("the latest view's handlers deliver, and a stale timer never sends a newer hold", () => {
    holdSend(draft("a"), 10_000);
    const later = vi.fn();
    setHeldSendHandlers({ deliver: later, undone });
    releaseHeldSend("box:other:1");
    expect(later).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(later).toHaveBeenCalledExactlyOnceWith(draft("a"));
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("a page closed during the wait", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  beforeEach(() => {
    vi.useFakeTimers();
    store.clear();
    vi.stubGlobal("window", { sessionStorage: storage, localStorage: storage });
    setHeldSendHandlers({ deliver: vi.fn(), undone: vi.fn() });
  });
  afterEach(() => {
    undoHeldSend();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("is reported once on the next visit, not while the send still waits in this page", () => {
    const send = holdSend(draft("a"), 10_000, 1_000);
    // A remount of the inbox during the wait: the send is still here.
    expect(takeInterruptedSend(2_000)).toBeNull();
    expect(store.get("mepmail.correio.heldSend")).toBe(JSON.stringify(send));
    // A reload drops this page's state (here: the undo) but not the stored marker.
    undoHeldSend();
    store.set("mepmail.correio.heldSend", JSON.stringify(send));
    expect(takeInterruptedSend(5_000)).toEqual(send);
    expect(takeInterruptedSend(5_000)).toBeNull();
  });

  it("leaves nothing to report once the send went or was undone", () => {
    holdSend(draft("a"), 10_000);
    vi.advanceTimersByTime(10_000);
    expect(takeInterruptedSend()).toBeNull();
    holdSend(draft("b"), 10_000);
    undoHeldSend();
    expect(takeInterruptedSend()).toBeNull();
  });

  it("ignores a leftover from the day before and a broken marker", () => {
    store.set(
      "mepmail.correio.heldSend",
      JSON.stringify({ key: "box:a:1", revision: draft("a"), deadline: 0 }),
    );
    expect(takeInterruptedSend(25 * 60 * 60 * 1000)).toBeNull();
    store.set("mepmail.correio.heldSend", "{");
    expect(takeInterruptedSend()).toBeNull();
  });
});
