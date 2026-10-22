import { QueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryRecoveryNotice } from "@/components/query-recovery";
import { queryHasUsableData, queryRecoveryPhase, recoverQuery } from "@/lib/query-recovery";

describe("read recovery states", () => {
  it.each([
    [{ isPending: true, fetchStatus: "fetching" }, "loading"],
    [{ isPending: true, fetchStatus: "paused" }, "paused"],
    [{ isError: true, fetchStatus: "idle" }, "error"],
    [{ data: ["cached"], isFetching: true }, "refreshing"],
    [{ data: ["cached"], fetchStatus: "paused" }, "paused"],
    [{ data: ["loaded"], fetchStatus: "idle" }, null],
  ] as const)("reports %j as %s", (query, expected) => {
    expect(queryRecoveryPhase(query)).toBe(expected);
  });

  it("preserves the current read's cached data during a network failure", () => {
    expect(
      queryHasUsableData({ data: ["cached"], isError: true, error: new Error("Network") }),
    ).toBe(true);
    expect(queryHasUsableData({ isPending: true })).toBe(false);
  });

  it.each(["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"])("hides cached data after %s", (code) => {
    expect(
      queryHasUsableData({ data: ["private"], isError: true, error: { data: { code } } }),
    ).toBe(false);
  });
});

describe("cancellation and retry of the exact current read", () => {
  it("restarts an initially stuck read without cancelling another mailbox or replacing its cache", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const active = ["mail", { mailboxId: "current" }] as const;
    const other = ["mail", { mailboxId: "other" }] as const;
    const abortCurrent = vi.fn();
    const abortOther = vi.fn();
    let finishOther: ((value: string) => void) | undefined;
    const pendingOther = client.fetchQuery({
      queryKey: other,
      queryFn: ({ signal }) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", abortOther);
          finishOther = resolve;
        }),
    });
    const pending = client
      .fetchQuery({
        queryKey: active,
        queryFn: ({ signal }) =>
          new Promise<string>(() => {
            signal.addEventListener("abort", abortCurrent);
          }),
      })
      .catch(() => "cancelled");
    try {
      await recoverQuery(client, active, () =>
        client.fetchQuery({
          queryKey: active,
          queryFn: async () => "recovered",
        }),
      );
      expect(await pending).toBe("cancelled");
      expect(abortCurrent).toHaveBeenCalledOnce();
      expect(abortOther).not.toHaveBeenCalled();
      expect(client.getQueryData(active)).toBe("recovered");
      expect(client.getQueryState(other)?.fetchStatus).toBe("fetching");
      if (!finishOther) throw new Error("Other mailbox did not start");
      finishOther("other mailbox");
      expect(await pendingOther).toBe("other mailbox");
      expect(client.getQueryData(other)).toBe("other mailbox");
    } finally {
      client.clear();
    }
  });

  it.each(["unmounted", "changed folder"])("does not retry after the scope was %s", async () => {
    let current = true;
    const cancelQueries = vi.fn(async () => {
      current = false;
    });
    const retry = vi.fn(async () => {});
    await recoverQuery({ cancelQueries }, ["mail", "old-scope"], retry, () => current);
    expect(cancelQueries).toHaveBeenCalledWith({ queryKey: ["mail", "old-scope"], exact: true });
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not cancel or restart a read whose scope already left", async () => {
    const cancelQueries = vi.fn(async () => {});
    const retry = vi.fn(async () => {});
    await recoverQuery({ cancelQueries }, ["mail", "old-scope"], retry, () => false);
    expect(cancelQueries).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});

type ButtonNode = ReactElement<{ children?: ReactNode; onClick?: () => void }>;
function findButton(value: ReactNode): ButtonNode | undefined {
  if (Array.isArray(value)) return value.map(findButton).find(Boolean);
  if (!value || typeof value !== "object" || !("props" in value)) return;
  const node = value as ButtonNode;
  return node.type === "button" ? node : findButton(node.props.children);
}

describe("accessible recovery action", () => {
  it.each(["loading", "paused", "error", "refreshing"] as const)(
    "keeps retry operable in %s, including an in-flight read",
    (phase) => {
      const retry = vi.fn(async () => {});
      const props = { phase, message: "Read status", retryLabel: "Try again", retry };
      const html = renderToStaticMarkup(createElement(QueryRecoveryNotice, props));
      expect(html).toContain(phase === "error" ? 'role="alert"' : 'role="status"');
      expect(html).toContain("Try again");
      expect(html).not.toContain("disabled");
      const button = findButton(QueryRecoveryNotice(props));
      if (!button?.props.onClick) throw new Error("Recovery action missing");
      button.props.onClick();
      expect(retry).toHaveBeenCalledOnce();
    },
  );
});
