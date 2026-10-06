import { describe, expect, it } from "vitest";
import { initialMailboxText, replaceMailboxSignature } from "../src/lib/mailbox-compose-signature";

describe("mailbox signature composition", () => {
  it("adds the selected box signature to a new message or reply", () => {
    expect(initialMailboxText("", "Suporte\nMepMail")).toBe("\n\n--\nSuporte\nMepMail");
  });
  it("places the sender signature before the forwarded quotation", () => {
    expect(initialMailboxText("> Original", "Jean", true)).toBe("\n\n--\nJean\n\n> Original");
  });
  it("switches an untouched footer while preserving the typed message", () => {
    expect(replaceMailboxSignature("Olá\n\n--\nJean", "Jean", "Suporte")).toBe(
      "Olá\n\n--\nSuporte",
    );
  });
  it("preserves a footer edited by the author", () => {
    expect(replaceMailboxSignature("Olá\n\n--\nJean / celular", "Jean", "Suporte")).toBe(
      "Olá\n\n--\nJean / celular",
    );
  });
  it("handles an empty signature without a dangling delimiter", () => {
    expect(initialMailboxText("Olá", "  ")).toBe("Olá");
    expect(replaceMailboxSignature("Olá\n\n--\nJean", "Jean", "")).toBe("Olá");
  });
});
