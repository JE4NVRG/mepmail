import { describe, expect, it } from "vitest";
import { isMailboxCategory, mailboxCategory } from "./mailbox-category";

const lines = (...entries: string[]) =>
  entries.map((line) => ({ key: line.slice(0, line.indexOf(":")).toLowerCase(), line }));

describe("mailbox category", () => {
  it("keeps a person's message with the people", () => {
    expect(mailboxCategory({ from: "maya@brightloop.example", headerLines: [] })).toBe("person");
    expect(
      mailboxCategory({
        from: "ana.souza@gmail.com",
        headerLines: lines("Auto-Submitted: no", "Subject: Re: proposta"),
      }),
    ).toBe("person");
  });

  it("puts system senders with the notifications, even with list headers", () => {
    expect(
      mailboxCategory({
        from: "notifications@github.com",
        headerLines: lines(
          "List-ID: <repo.github.com>",
          "List-Unsubscribe: <https://github.com/u>",
          "Precedence: list",
        ),
      }),
    ).toBe("notification");
    expect(mailboxCategory({ from: "no-reply@bank.example", headerLines: [] })).toBe(
      "notification",
    );
    expect(mailboxCategory({ from: "store-noreply@shop.example", headerLines: [] })).toBe(
      "notification",
    );
    expect(mailboxCategory({ from: "receipts+acct_1@stripe.com", headerLines: [] })).toBe(
      "notification",
    );
    expect(
      mailboxCategory({
        from: "maya@brightloop.example",
        headerLines: lines("Auto-Submitted: auto-replied"),
      }),
    ).toBe("notification");
  });

  it("puts list mail with the newsletters", () => {
    expect(
      mailboxCategory({
        from: "contato@loja.example",
        headerLines: lines("List-Unsubscribe: <mailto:sair@loja.example>"),
      }),
    ).toBe("newsletter");
    expect(
      mailboxCategory({ from: "team@product.example", headerLines: lines("Precedence: bulk") }),
    ).toBe("newsletter");
    expect(mailboxCategory({ from: "newsletter@jornal.example", headerLines: [] })).toBe(
      "newsletter",
    );
    // A word inside a person's address is not a sender role.
    expect(mailboxCategory({ from: "newsom@example.com", headerLines: [] })).toBe("person");
  });

  it("recognizes only its own values", () => {
    expect(isMailboxCategory("newsletter")).toBe(true);
    expect(isMailboxCategory("spam")).toBe(false);
    expect(isMailboxCategory(null)).toBe(false);
  });
});
