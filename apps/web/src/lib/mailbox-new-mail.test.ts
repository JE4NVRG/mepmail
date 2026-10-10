import { describe, expect, it } from "vitest";
import { type NewMailRow, newMailNotices, rememberUnread } from "./mailbox-new-mail";

const labels = {
  fallbackTitle: "Correio",
  noSubject: "(sem assunto)",
  count: (count: number) => `${count} mensagens novas`,
  more: (count: number) => `e mais ${count}`,
};
const fallback = { title: "Correio", body: "2 mensagens novas" };
const row = (id: string, extra: Partial<NewMailRow> = {}): NewMailRow => ({
  id,
  mailboxId: "box",
  seenAt: null,
  from: `${id}@example.com`,
  fromName: `Pessoa ${id}`,
  subject: `Assunto ${id}`,
  ...extra,
});

describe("newMailNotices", () => {
  it("keeps notifications and newsletters quiet with the smart inbox, and stays silent when all are", () => {
    const quiet = (r: NewMailRow) => r.category === "notification" || r.category === "newsletter";
    const notified = new Set<string>();
    expect(
      newMailNotices(
        [
          row("a", { category: "person" }),
          row("ci", { category: "notification" }),
          row("news", { category: "newsletter" }),
        ],
        notified,
        labels,
        fallback,
        quiet,
      ),
    ).toEqual([{ title: "Pessoa a", body: "Assunto a", row: { mailboxId: "box", id: "a" } }]);
    // Quiet rows count as announced: they never come back later.
    expect(notified.has("box:ci")).toBe(true);
    expect(
      newMailNotices([row("promo", { category: "newsletter" })], notified, labels, fallback, quiet),
    ).toEqual([]);
  });

  it("announces each new unread message by sender and subject, once", () => {
    const notified = new Set<string>();
    rememberUnread([row("old")], notified);
    const rows = [
      row("a"),
      row("b", { fromName: "", subject: "" }),
      row("old"),
      row("read", { seenAt: new Date() }),
    ];
    expect(newMailNotices(rows, notified, labels, fallback)).toEqual([
      // Each names its message, so the notice can open it.
      { title: "Pessoa a", body: "Assunto a", row: { mailboxId: "box", id: "a" } },
      { title: "b@example.com", body: "(sem assunto)", row: { mailboxId: "box", id: "b" } },
    ]);
    expect(newMailNotices(rows, notified, labels, fallback)).toEqual([fallback]);
  });

  it("sums up more than three new messages in one notification", () => {
    const notices = newMailNotices(
      ["a", "b", "c", "d", "e"].map((id) => row(id)),
      new Set(),
      labels,
      fallback,
    );
    expect(notices).toEqual([
      {
        title: "5 mensagens novas",
        body: "Pessoa a: Assunto a\nPessoa b: Assunto b\nPessoa c: Assunto c\ne mais 2",
      },
    ]);
  });

  it("falls back to the count when the new mail is not among the rows", () => {
    expect(newMailNotices([], new Set(), labels, fallback)).toEqual([fallback]);
  });
});
