import { describe, expect, it } from "vitest";
import {
  SubscriptionProjectionChangedError,
  withSubscriptionProjectionRetry,
} from "../src/subscription-projection-retry.js";

describe("bounded fresh subscription projection retry", () => {
  it("awaits rollback and prepares fresh authority, never reuses the stale snapshot", async () => {
    const events: string[] = [];
    let generation = 0;
    let rolledBack = false;
    const result = await withSubscriptionProjectionRetry(
      async () => {
        if (generation) expect(rolledBack).toBe(true);
        events.push(`prepare:${++generation}`);
        return { generation };
      },
      async (prepared) => {
        events.push(`apply:${prepared.generation}`);
        if (prepared.generation === 1) {
          await Promise.resolve();
          rolledBack = true;
          events.push("rollback:1");
          throw new SubscriptionProjectionChangedError("stale");
        }
        return prepared.generation;
      },
    );
    expect(result).toBe(2);
    expect(events).toEqual(["prepare:1", "apply:1", "rollback:1", "prepare:2", "apply:2"]);
  });
  it("propagates persistent conflict after exactly two prepared attempts", async () => {
    let reads = 0;
    let writes = 0;
    const conflict = new SubscriptionProjectionChangedError("still stale");
    await expect(
      withSubscriptionProjectionRetry(
        async () => ++reads,
        async () => {
          writes++;
          throw conflict;
        },
      ),
    ).rejects.toBe(conflict);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
  });
  it.each([
    new Error("Projection changed after provider readback"),
    new TypeError("identity"),
    { name: "SubscriptionProjectionChangedError" },
  ])("does not retry an untyped, forged or unrelated error %#", async (failure) => {
    let reads = 0;
    await expect(
      withSubscriptionProjectionRetry(
        async () => ++reads,
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(reads).toBe(1);
  });
  it("does not retry a provider/preflight failure, even if it uses the conflict class", async () => {
    let reads = 0;
    let writes = 0;
    const failure = new SubscriptionProjectionChangedError("preflight unavailable");
    await expect(
      withSubscriptionProjectionRetry(
        async () => {
          reads++;
          throw failure;
        },
        async () => {
          writes++;
        },
      ),
    ).rejects.toBe(failure);
    expect(reads).toBe(1);
    expect(writes).toBe(0);
  });
  it("keeps a duplicate event no-op terminal, without repeating effects", async () => {
    let reads = 0;
    let writes = 0;
    expect(
      await withSubscriptionProjectionRetry(
        async () => ++reads,
        async () => {
          writes++;
          return null;
        },
      ),
    ).toBe(null);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });
});
