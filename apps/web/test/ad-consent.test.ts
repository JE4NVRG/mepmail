import { describe, expect, it, vi } from "vitest";
import { AD_POLICY_VERSION, createAdConsentStore } from "@/lib/ad-consent";

const receipt = (state: "accepted" | "denied" | "unknown") =>
  new Response(JSON.stringify({ state, policyVersion: AD_POLICY_VERSION }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("advertising consent rechecks", () => {
  it("coalesces visibility bursts for 30 seconds and rechecks at the expiry boundary", async () => {
    let clock = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => receipt("denied"));
    const store = createAdConsentStore(request, () => clock);
    await store.read();
    for (let event = 0; event < 12; event++) {
      clock += 1000;
      await store.read();
    }
    clock = 29_999;
    await store.read();
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ state: "denied", pending: false, error: false });
    clock = 30_000;
    await store.read();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("lets explicit actions bypass freshness while deduplicating all reads in flight", async () => {
    const pending = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt("accepted"))
      .mockReturnValueOnce(pending.promise);
    const store = createAdConsentStore(request, () => 0);
    await store.read();
    const forced = store.read({ force: true });
    expect(store.read()).toBe(forced);
    expect(store.read({ force: true })).toBe(forced);
    expect(request).toHaveBeenCalledTimes(2);
    pending.resolve(receipt("denied"));
    await forced;
    expect(store.getSnapshot().state).toBe("denied");
    await store.read();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("backs off failure storms for 5 seconds and allows an explicit immediate retry", async () => {
    let clock = 0;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(receipt("denied"));
    const store = createAdConsentStore(request, () => clock);
    await store.read();
    for (let event = 0; event < 10; event++) {
      clock += 400;
      await store.read();
    }
    clock = 4999;
    await store.read();
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ state: "unknown", pending: false, error: true });
    clock = 5000;
    await store.read();
    expect(request).toHaveBeenCalledTimes(2);
    await store.read();
    expect(request).toHaveBeenCalledTimes(2);
    await store.read({ force: true });
    expect(request).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).toEqual({ state: "denied", pending: false, error: false });
  });

  it.each(["local", "persisted"] as const)(
    "revokes synchronously and ignores a delayed accepted GET after a %s withdrawal",
    async (mode) => {
      const pendingRead = deferred<Response>();
      const pendingWrite = deferred<Response>();
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(receipt("accepted"))
        .mockReturnValueOnce(pendingRead.promise)
        .mockReturnValueOnce(pendingWrite.promise);
      const store = createAdConsentStore(request, () => 0);
      await store.read();
      const reading = store.read({ force: true });
      let writing: Promise<void> | undefined;
      if (mode === "local") store.blockLocally();
      else writing = store.choose(false);
      expect(store.getSnapshot().state).toBe("denied");
      pendingRead.resolve(receipt("accepted"));
      await reading;
      expect(store.getSnapshot().state).toBe("denied");
      if (writing) {
        expect(store.getSnapshot().pending).toBe(true);
        const whilePending = store.read({ force: true });
        pendingWrite.resolve(receipt("denied"));
        await writing;
        await whilePending;
        expect(request).toHaveBeenCalledTimes(3);
      }
      expect(store.getSnapshot()).toEqual({
        state: "denied",
        pending: false,
        error: mode === "local",
      });
    },
  );

  it("never lets a warm read cache activate a new acceptance before its POST succeeds", async () => {
    const pending = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt("accepted"))
      .mockReturnValueOnce(pending.promise);
    const store = createAdConsentStore(request, () => 0);
    await store.read();
    const choice = store.choose(true);
    expect(store.getSnapshot()).toEqual({ state: "unknown", pending: true, error: false });
    const reading = store.read({ force: true });
    pending.resolve(receipt("accepted"));
    await choice;
    await reading;
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(store.getSnapshot()).toEqual({ state: "accepted", pending: false, error: false });
  });
});
