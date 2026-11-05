import { readFileSync } from "node:fs";
import { MutationObserver, onlineManager, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  MAILBOX_READ_QUERY_OPTIONS,
  mailboxReadAccessRefused,
  mailboxReaderHasUsableData,
  mailboxReadRetryDelay,
  retryMailboxRead,
} from "@/lib/mailbox-read-retry";
import { queryHasUsableData, recoverQuery } from "@/lib/query-recovery";

const refusal = (code: string) => ({ data: { code } });

// Synthetic query functions exercise the real QueryClient without a network or real mail.
describe("Correio safe read retries", () => {
  it("recovers an initial transient mailbox open without reloading or fetching another box", async () => {
    const client = new QueryClient();
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ mailboxId: "a", items: ["synthetic"] });
    const other = ["mail", { mailboxId: "b" }];
    client.setQueryData(other, { items: ["other"] });
    try {
      const result = await client.fetchQuery({
        queryKey: ["mail", { mailboxId: "a" }],
        ...MAILBOX_READ_QUERY_OPTIONS,
        retryDelay: 0,
        queryFn,
      });
      expect(result).toEqual({ mailboxId: "a", items: ["synthetic"] });
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(other)).toEqual({ items: ["other"] });
      expect(client.getQueryState(other)?.fetchStatus).toBe("idle");
    } finally {
      client.clear();
    }
  });

  it("bounds persistent failures to three total attempts", async () => {
    const client = new QueryClient();
    const error = Object.assign(
      new Error("Temporarily unavailable"),
      refusal("SERVICE_UNAVAILABLE"),
    );
    const queryFn = vi.fn().mockRejectedValue(error);
    try {
      await expect(
        client.fetchQuery({
          queryKey: ["persistent"],
          ...MAILBOX_READ_QUERY_OPTIONS,
          retryDelay: 0,
          queryFn,
        }),
      ).rejects.toBe(error);
      expect(queryFn).toHaveBeenCalledTimes(3);
    } finally {
      client.clear();
    }
  });

  it.each([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "BAD_REQUEST",
    "TOO_MANY_REQUESTS",
    "PRECONDITION_FAILED",
  ])("does not automatically retry %s", async (code) => {
    const client = new QueryClient();
    const error = Object.assign(new Error("Synthetic refusal"), refusal(code));
    const queryFn = vi.fn().mockRejectedValue(error);
    try {
      await expect(
        client.fetchQuery({
          queryKey: [code],
          ...MAILBOX_READ_QUERY_OPTIONS,
          retryDelay: 0,
          queryFn,
        }),
      ).rejects.toBe(error);
      expect(queryFn).toHaveBeenCalledOnce();
    } finally {
      client.clear();
    }
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "does not expose cached private content after %s",
    async (code) => {
      const client = new QueryClient();
      const key = ["private", code];
      client.setQueryData(key, "synthetic private content");
      const error = Object.assign(new Error("Synthetic access refusal"), refusal(code));
      try {
        await expect(
          client.fetchQuery({
            queryKey: key,
            ...MAILBOX_READ_QUERY_OPTIONS,
            retryDelay: 0,
            staleTime: 0,
            queryFn: async () => {
              throw error;
            },
          }),
        ).rejects.toBe(error);
        const state = client.getQueryState(key);
        expect(mailboxReadAccessRefused(state?.error)).toBe(true);
        expect(queryHasUsableData({ data: state?.data, error: state?.error })).toBe(false);
      } finally {
        client.clear();
      }
    },
  );

  it("keeps list cache but does not render a failed private reader refresh", async () => {
    const client = new QueryClient();
    const key = ["item", { mailboxId: "a", id: "synthetic-message" }];
    client.setQueryData(key, { body: "synthetic cached content" });
    const error = new TypeError("Failed to fetch");
    try {
      await expect(
        client.fetchQuery({
          queryKey: key,
          ...MAILBOX_READ_QUERY_OPTIONS,
          retryDelay: 0,
          staleTime: 0,
          queryFn: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const state = client.getQueryState(key);
      expect(mailboxReadAccessRefused(state?.error)).toBe(false);
      expect(queryHasUsableData({ data: state?.data, error: state?.error })).toBe(true);
      expect(
        mailboxReaderHasUsableData({
          data: state?.data,
          error: state?.error,
          isError: state?.status === "error",
        }),
      ).toBe(false);
      expect(
        client.getQueryData(["item", { mailboxId: "b", id: "synthetic-message" }]),
      ).toBeUndefined();
    } finally {
      client.clear();
    }
  });

  it("lets an explicit retry recover the exact failed read without a page reload", async () => {
    const client = new QueryClient();
    const key = ["item", { mailboxId: "a", id: "message" }];
    client.setQueryData(key, "cached");
    try {
      await recoverQuery(client, key, () =>
        client.fetchQuery({
          queryKey: key,
          ...MAILBOX_READ_QUERY_OPTIONS,
          retryDelay: 0,
          staleTime: 0,
          queryFn: async () => "recovered",
        }),
      );
      expect(client.getQueryData(key)).toBe("recovered");
    } finally {
      client.clear();
    }
  });

  it("does not retry aborted requests or untyped values", () => {
    const aborted = Object.assign(new Error("Cancelled"), { name: "AbortError" });
    expect(retryMailboxRead(0, aborted)).toBe(false);
    expect(
      retryMailboxRead(0, Object.assign(new Error("Cancelled wrapper"), { cause: aborted })),
    ).toBe(false);
    expect(
      retryMailboxRead(
        0,
        Object.assign(new Error("Cancelled with transient code"), {
          cause: aborted,
          ...refusal("TIMEOUT"),
        }),
      ),
    ).toBe(false);
    expect(retryMailboxRead(0, { message: "unknown" })).toBe(false);
    expect(retryMailboxRead(2, new TypeError("Failed to fetch"))).toBe(false);
    expect(mailboxReadRetryDelay(0)).toBe(250);
    expect(mailboxReadRetryDelay(1)).toBe(750);
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "never revives private content on success -> %s -> network failure",
    async (code) => {
      const client = new QueryClient();
      const key = ["reader", { mailboxId: "a", id: "private-message" }];
      const read = () => {
        const state = client.getQueryState(key);
        return { data: state?.data, error: state?.error, isError: state?.status === "error" };
      };
      try {
        await client.fetchQuery({ queryKey: key, queryFn: async () => "old authorized content" });
        expect(mailboxReaderHasUsableData(read())).toBe(true);
        const denied = Object.assign(new Error("Access refused"), refusal(code));
        await expect(
          client.fetchQuery({
            queryKey: key,
            ...MAILBOX_READ_QUERY_OPTIONS,
            retryDelay: 0,
            staleTime: 0,
            queryFn: async () => {
              throw denied;
            },
          }),
        ).rejects.toBe(denied);
        expect(mailboxReaderHasUsableData(read())).toBe(false);
        const disconnected = new TypeError("Failed to fetch");
        await expect(
          client.fetchQuery({
            queryKey: key,
            ...MAILBOX_READ_QUERY_OPTIONS,
            retryDelay: 0,
            staleTime: 0,
            queryFn: async () => {
              throw disconnected;
            },
          }),
        ).rejects.toBe(disconnected);
        expect(client.getQueryData(key)).toBe("old authorized content");
        expect(mailboxReaderHasUsableData(read())).toBe(false);
        await client.fetchQuery({
          queryKey: key,
          ...MAILBOX_READ_QUERY_OPTIONS,
          staleTime: 0,
          queryFn: async () => "new authorized content",
        });
        expect(mailboxReaderHasUsableData(read())).toBe(true);
        expect(client.getQueryData(key)).toBe("new authorized content");
      } finally {
        client.clear();
      }
    },
  );

  it("does not recover mailbox A after the selection changed to B during cancellation", async () => {
    const client = new QueryClient();
    const a = ["reader", { mailboxId: "a", id: "a-message" }];
    const b = ["reader", { mailboxId: "b", id: "b-message" }];
    const aborted = vi.fn();
    let selected = "a";
    client.setQueryData(b, "B content");
    const pending = client
      .fetchQuery({
        queryKey: a,
        queryFn: ({ signal }) =>
          new Promise<string>(() => signal.addEventListener("abort", aborted)),
      })
      .catch(() => "cancelled");
    const retry = vi.fn(async () => "must not run");
    try {
      const recovering = recoverQuery(client, a, retry, () => selected === "a");
      selected = "b";
      await recovering;
      expect(await pending).toBe("cancelled");
      expect(aborted).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(client.getQueryData(b)).toBe("B content");
      expect(client.getQueryState(b)?.fetchStatus).toBe("idle");
    } finally {
      client.clear();
    }
  });

  it("pauses a read while offline and resumes it once online without a reload", async () => {
    const client = new QueryClient();
    const key = ["reader", "offline"];
    const queryFn = vi.fn(async () => "reconnected content");
    client.mount();
    onlineManager.setOnline(false);
    try {
      const pending = client.fetchQuery({
        queryKey: key,
        ...MAILBOX_READ_QUERY_OPTIONS,
        retryDelay: 0,
        queryFn,
      });
      expect(client.getQueryState(key)?.fetchStatus).toBe("paused");
      expect(queryFn).not.toHaveBeenCalled();
      onlineManager.setOnline(true);
      expect(await pending).toBe("reconnected content");
      expect(queryFn).toHaveBeenCalledOnce();
    } finally {
      onlineManager.setOnline(true);
      client.unmount();
      client.clear();
    }
  });

  it("never repeats a failed mailbox mutation", async () => {
    const client = new QueryClient();
    const mutationFn = vi.fn().mockRejectedValue(new TypeError("Network failed after mutation"));
    const mutation = new MutationObserver(client, { mutationFn, retry: false });
    try {
      await expect(mutation.mutate(undefined)).rejects.toThrow("Network failed after mutation");
      expect(mutationFn).toHaveBeenCalledOnce();
    } finally {
      client.clear();
    }
  });
});

describe("Correio read integration", () => {
  const view = readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailboxes-view.tsx", import.meta.url),
    "utf8",
  );
  const content = readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
    "utf8",
  );

  it("uses safe retry options on folder/message reads and keeps mutations explicitly non-retrying", () => {
    expect(view).toContain("...MAILBOX_READ_QUERY_OPTIONS");
    expect(content).toContain("...MAILBOX_READ_QUERY_OPTIONS");
    expect(content).toContain("queueDraft.mutationOptions({ retry: false })");
    expect(content).toContain("setSeen.mutationOptions({ retry: false })");
    expect(content).toContain("setTrash.mutationOptions({ retry: false })");
    expect(view).toContain("reorderFolders.mutationOptions({ retry: false })");
  });

  it("distinguishes a transient reader error from access loss and retries the exact current message", () => {
    expect(content).toContain("visibleItem && mailboxReaderHasUsableData(detail)");
    expect(content).toContain("detail.isError && visibleItem && detailRefused");
    expect(content).toContain("currentDetailScope.current === detailScope");
    expect(content).toContain("retry={recoverDetail}");
  });
});
