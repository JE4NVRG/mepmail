import { describe, expect, it } from "vitest";
import { settleWithin } from "./settle-within";

const later = (ms: number, value?: unknown) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe("settleWithin", () => {
  it("returns as soon as every task settles, failures included", async () => {
    const started = Date.now();
    await settleWithin([later(5), Promise.reject(new Error("slow kms")), later(10)], 1000);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stops waiting at the deadline when a task never ends", async () => {
    const started = Date.now();
    let late = false;
    const slow = later(400).then(() => {
      late = true;
    });
    await settleWithin([later(5), new Promise(() => {}), slow], 50);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(40);
    expect(waited).toBeLessThan(300);
    expect(late).toBe(false);
  });

  it("returns at once with nothing to wait for", async () => {
    const started = Date.now();
    await settleWithin([], 1000);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
