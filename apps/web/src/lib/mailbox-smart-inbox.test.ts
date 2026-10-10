import { describe, expect, it } from "vitest";
import { knownPeopleFrom, pileCounts, rowPile, shouldLoadMore } from "./mailbox-smart-inbox";

const row = (
  from: string,
  category: "person" | "notification" | "newsletter" | null,
  seen = true,
) => ({
  from,
  category,
  seen,
});

describe("smart inbox", () => {
  const known = knownPeopleFrom([{ to: ["Billing@Client.example "] }, { to: [] }]);

  it("files rows by category, keeping people this person wrote to with the people", () => {
    expect(rowPile(row("ana@example.com", "person"), known)).toBe("people");
    expect(rowPile(row("no-reply@bank.example", "notification"), known)).toBe("notifications");
    expect(rowPile(row("contato@loja.example", "newsletter"), known)).toBe("newsletters");
    expect(rowPile(row("billing@client.example", "notification"), known)).toBe("people");
    // Withheld content has no category: it is never tucked away.
    expect(rowPile(row("", null), known)).toBe("people");
  });

  it("keeps an approved sender with the people ('Mover para Pessoas')", () => {
    const news = row("contato@loja.example", "newsletter");
    expect(rowPile({ ...news, senderDecision: "allow" }, known)).toBe("people");
    expect(rowPile({ ...news, senderDecision: "none" }, known)).toBe("newsletters");
    expect(rowPile({ ...news, senderDecision: "block" }, known)).toBe("newsletters");
    expect(rowPile({ ...news, senderDecision: null }, known)).toBe("newsletters");
    const counts = pileCounts(
      [news, { ...row("no-reply@bank.example", "notification"), senderDecision: "allow" as const }],
      known,
      () => false,
    );
    expect(counts.people.total).toBe(1);
    expect(counts.notifications.total).toBe(0);
    expect(counts.newsletters.total).toBe(1);
  });

  it("counts every pile and the whole inbox, with unread", () => {
    const counts = pileCounts(
      [
        row("ana@example.com", "person", false),
        row("no-reply@bank.example", "notification", false),
        row("alerts@cloud.example", "notification"),
        row("contato@loja.example", "newsletter"),
      ],
      known,
      (r) => !r.seen,
    );
    expect(counts).toEqual({
      people: { total: 1, unread: 1 },
      notifications: { total: 2, unread: 1 },
      newsletters: { total: 1, unread: 0 },
      all: { total: 4, unread: 2 },
    });
  });

  it("loads more pages only while a pile is thin and within the page budget", () => {
    const base = { shown: 3, pagesLoaded: 1, hasNextPage: true, fetching: false };
    expect(shouldLoadMore(base)).toBe(true);
    expect(shouldLoadMore({ ...base, shown: 12 })).toBe(false);
    expect(shouldLoadMore({ ...base, fetching: true })).toBe(false);
    expect(shouldLoadMore({ ...base, hasNextPage: false })).toBe(false);
    expect(shouldLoadMore({ ...base, pagesLoaded: 5 })).toBe(false);
    expect(shouldLoadMore({ ...base, pagesLoaded: 0 })).toBe(false);
  });
});
