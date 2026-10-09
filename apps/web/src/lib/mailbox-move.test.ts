import { describe, expect, it } from "vitest";
import {
  MAILBOX_FOLDERS_MAX,
  mailboxMoveOptions,
  normalizeMailboxFolderName,
} from "./mailbox-move";

const folders = [
  { id: "1", name: "Clientes" },
  { id: "2", name: "Financeiro" },
  { id: "3", name: "Faturas 2026" },
];

describe("mailboxMoveOptions", () => {
  it("lists every folder in order while nothing is typed, with nothing to create", () => {
    expect(mailboxMoveOptions(folders, "")).toEqual({ matches: folders, createName: null });
    expect(mailboxMoveOptions(folders, "   ").createName).toBeNull();
  });

  it("filters by any part of the name, ignoring case and accents", () => {
    expect(mailboxMoveOptions(folders, "fa").matches.map((f) => f.id)).toEqual(["3"]);
    expect(mailboxMoveOptions(folders, "FINAN").matches.map((f) => f.id)).toEqual(["2"]);
    const accents = [{ id: "4", name: "Órgãos públicos" }];
    expect(mailboxMoveOptions(accents, "orgaos").matches.map((f) => f.id)).toEqual(["4"]);
  });

  it("offers a new folder with the name the server would store", () => {
    expect(mailboxMoveOptions(folders, "  Fatu  ").createName).toBe("Fatu");
    expect(mailboxMoveOptions(folders, "Notas   fiscais").createName).toBe("Notas fiscais");
  });

  it("never offers a name the server would refuse", () => {
    expect(mailboxMoveOptions(folders, "clientes").createName).toBeNull();
    expect(mailboxMoveOptions(folders, "x".repeat(81)).createName).toBeNull();
    const full = Array.from({ length: MAILBOX_FOLDERS_MAX }, (_, i) => ({
      id: String(i),
      name: `P${i}`,
    }));
    expect(mailboxMoveOptions(full, "Nova").createName).toBeNull();
  });
});

describe("normalizeMailboxFolderName", () => {
  it("trims and collapses inner spaces like the server", () => {
    expect(normalizeMailboxFolderName("  a \t b\n c ")).toBe("a b c");
  });
});
