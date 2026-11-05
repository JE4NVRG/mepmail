import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAILBOX_SEEN_BATCH,
  MAILBOX_SEEN_MAILBOX_BATCH,
  mailboxSeenBatches,
} from "@/lib/mailbox-seen-batches";

const row = (i: number, mailboxId = `box-${i}`) => ({ id: `message-${i}`, mailboxId });

describe("bulk seen request bounds", () => {
  it("does not create an empty mutation", () => {
    expect(mailboxSeenBatches([])).toEqual([]);
  });

  it("covers 65 mailboxes in two valid requests, without dropping or reordering rows", () => {
    const rows = Array.from({ length: 65 }, (_, i) => row(i));
    const batches = mailboxSeenBatches(rows);
    expect(batches.map((batch) => batch.length)).toEqual([50, 15]);
    expect(batches.flat()).toEqual(rows);
  });

  it("allows exactly fifty mailboxes in one request", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    expect(mailboxSeenBatches(rows)).toEqual([rows]);
  });

  it("still splits a single mailbox at the two-hundred-message bound", () => {
    const rows = Array.from({ length: 401 }, (_, i) => row(i, "one-box"));
    expect(mailboxSeenBatches(rows).map((batch) => batch.length)).toEqual([200, 200, 1]);
  });

  it("keeps existing-mailbox rows in a nonfull batch, then splits before the fifty-first box", () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => row(i)),
      ...Array.from({ length: 20 }, (_, i) => row(50 + i, "box-0")),
      row(70, "box-50"),
    ];
    const batches = mailboxSeenBatches(rows);
    expect(batches.map((batch) => batch.length)).toEqual([70, 1]);
    expect(batches.flat()).toEqual(rows);
  });

  it("preserves every row and both bounds when mailbox identities recur", () => {
    const rows = Array.from({ length: 1005 }, (_, i) => row(i, `box-${i % 65}`));
    const batches = mailboxSeenBatches(rows);
    expect(batches.flat()).toEqual(rows);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(MAILBOX_SEEN_BATCH);
      expect(new Set(batch.map((item) => item.mailboxId)).size).toBeLessThanOrEqual(
        MAILBOX_SEEN_MAILBOX_BATCH,
      );
    }
  });

  it("does not mutate a frozen input array or its rows", () => {
    const rows = Object.freeze(Array.from({ length: 65 }, (_, i) => Object.freeze(row(i))));
    const batches = mailboxSeenBatches(rows);
    expect(batches.flat()).toEqual(rows);
    expect(batches[0]![0]).toBe(rows[0]);
  });

  it("allows the sequential consumer to stop on failure without repeating completed mutations", async () => {
    const rows = Array.from({ length: 130 }, (_, i) => row(i));
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fixture"));
    await expect(
      (async () => {
        for (const batch of mailboxSeenBatches(rows)) await mutate(batch);
      })(),
    ).rejects.toThrow("fixture");
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls.map(([batch]) => batch.length)).toEqual([50, 50]);
  });

  it("is wired into the real read/unread consumer while matching both unchanged server limits", () => {
    const consumer = readFileSync(
      new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
      "utf8",
    );
    const server = readFileSync(
      new URL("../../../packages/core/src/mailbox-private-store.ts", import.meta.url),
      "utf8",
    );
    expect(consumer).toContain("for (const batch of mailboxSeenBatches(rows))");
    expect(consumer).not.toContain("start += MAILBOX_SEEN_BATCH");
    expect(server).toContain(`export const MAILBOX_SEEN_BATCH = ${MAILBOX_SEEN_BATCH};`);
    expect(server).toContain(`const MAX_READ_MAILBOXES = ${MAILBOX_SEEN_MAILBOX_BATCH};`);
  });
});
