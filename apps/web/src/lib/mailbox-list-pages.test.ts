import { describe, expect, it } from "vitest";
import { mergeMailboxHead } from "./mailbox-list-pages";

type R = { mailboxId: string; id: string; seen?: boolean };
type P = { items: R[]; nextCursor: string | null; mailboxesTruncated?: boolean };

const row = (id: string, seen = false): R => ({ mailboxId: "box", id, seen });
const page = (ids: string[], nextCursor: string | null): P => ({
  items: ids.map((id) => row(id)),
  nextCursor,
});
const ids = (pages: P[]) => pages.map((p) => p.items.map((r) => r.id));
const data = (pages: P[]) => ({
  pages,
  pageParams: [undefined, ...pages.slice(1).map((_, index) => `c${index}`)],
});

describe("mergeMailboxHead", () => {
  it("keeps later pages when the fresh first page still reaches the boundary", () => {
    const shown = data([page(["a", "b", "c"], "c1"), page(["d", "e"], "c2")]);
    const fresh = {
      ...page(["a", "b", "c", "d"], "x"),
      items: [row("a", true), row("b"), row("c"), row("d")],
    };
    const merged = mergeMailboxHead(shown, fresh);
    expect(merged && ids(merged.pages)).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    expect(merged?.pages[0]?.items[0]?.seen).toBe(true);
    expect(merged?.pages[0]?.nextCursor).toBe("c1");
    expect(merged?.pageParams).toEqual(shown.pageParams);
  });

  it("keeps the rows new mail pushed out of the first page, so nothing goes missing", () => {
    const shown = data([page(["a", "b", "c"], "c1"), page(["d", "e"], "c2")]);
    const merged = mergeMailboxHead(shown, page(["n", "a", "b"], "x"));
    expect(merged && ids(merged.pages)).toEqual([
      ["n", "a", "b", "c"],
      ["d", "e"],
    ]);
    expect(merged?.pages[0]?.nextCursor).toBe("c1");
  });

  it("drops rows deleted elsewhere from the first page", () => {
    const shown = data([page(["a", "b", "c"], "c1"), page(["d"], null)]);
    const merged = mergeMailboxHead(shown, page(["a", "c", "d"], "x"));
    expect(merged && ids(merged.pages)).toEqual([["a", "c"], ["d"]]);
  });

  it("shows a draft moved from a later page to the top only once", () => {
    const shown = data([page(["a", "b"], "c1"), page(["c", "d"], "c2")]);
    const merged = mergeMailboxHead(shown, page(["d", "a", "b"], "x"));
    expect(merged && ids(merged.pages)).toEqual([["d", "a", "b"], ["c"]]);
  });

  it("replaces every page when the fresh page holds the whole list", () => {
    const shown = data([page(["a", "b"], "c1"), page(["c"], null)]);
    const merged = mergeMailboxHead(shown, page(["a", "c"], null));
    expect(merged && ids(merged.pages)).toEqual([["a", "c"]]);
    expect(merged?.pageParams).toEqual([undefined]);
  });

  it("asks for a full refetch when the pages cannot be reconciled", () => {
    const shown = data([page(["a", "b", "c"], "c1"), page(["d", "e"], "c2")]);
    // More new mail than one page: nothing in common with the old first page.
    expect(mergeMailboxHead(shown, page(["x", "y", "z"], "x"))).toBeNull();
    // The boundary row vanished and the fresh page already reaches page two.
    expect(mergeMailboxHead(shown, page(["a", "b", "d"], "x"))).toBeNull();
    expect(mergeMailboxHead({ pages: [], pageParams: [] }, page(["a"], "x"))).toBeNull();
    expect(
      mergeMailboxHead(data([page([], "c1"), page(["a"], null)]), page(["a"], "x")),
    ).toBeNull();
  });

  it("takes the other fields of the fresh first page", () => {
    const shown = data([{ ...page(["a"], "c1"), mailboxesTruncated: false }, page(["b"], null)]);
    const merged = mergeMailboxHead(shown, { ...page(["a", "b"], "x"), mailboxesTruncated: true });
    expect(merged?.pages[0]?.mailboxesTruncated).toBe(true);
  });
});
