import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { CORREIO_OFFLINE_MESSAGE_LIMIT, correioOfflineState } from "./correio-offline";

const key = (path: string[], input: unknown = {}) => [path, { input, type: "query" }];

describe("correioOfflineState", () => {
  it("keeps what the inbox shows, never credentials or billing", () => {
    const client = new QueryClient();
    client.setQueryData(key(["mailboxes", "list"]), { mailboxes: [] });
    client.setQueryData(key(["mailboxes", "unreadCounts"]), { counts: {} });
    client.setQueryData(key(["mailboxes", "agentKeys"], { mailboxId: "m" }), [{ token: "x" }]);
    client.setQueryData(key(["mailboxes", "billing"]), { plan: "x" });
    client.setQueryData(key(["settings", "get"]), { a: 1 });
    const kept = correioOfflineState(client).queries.map((q) =>
      (q.queryKey[0] as string[]).join("."),
    );
    expect(kept.sort()).toEqual(["mailboxes.list", "mailboxes.unreadCounts"]);
  });

  it("keeps the newest opened messages up to the limit", () => {
    const client = new QueryClient();
    const total = CORREIO_OFFLINE_MESSAGE_LIMIT + 5;
    for (let i = 0; i < total; i++)
      client.setQueryData(
        key(["mailboxes", "item"], { mailboxId: "m", id: `i${i}` }),
        { id: `i${i}` },
        {
          updatedAt: 1_000 + i,
        },
      );
    const items = correioOfflineState(client).queries.filter(
      (q) => (q.queryKey[0] as string[])[1] === "item",
    );
    expect(items).toHaveLength(CORREIO_OFFLINE_MESSAGE_LIMIT);
    const ids = items.map((q) => (q.state.data as { id: string }).id);
    expect(ids).toContain(`i${total - 1}`);
    expect(ids).not.toContain("i0");
  });
});
