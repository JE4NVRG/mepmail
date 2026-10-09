import { describe, expect, it } from "vitest";
import { mailboxFolderOrderAfterMove, mailboxFolderTint } from "./mailbox-inbox-presentation";

describe("mailboxFolderTint", () => {
  it("accepts the server's named colors and nothing else", () => {
    expect(mailboxFolderTint("violet")).toBe("violet");
    expect(mailboxFolderTint("teal")).toBe("teal");
    expect(mailboxFolderTint(null)).toBeNull();
    expect(mailboxFolderTint(undefined)).toBeNull();
    expect(mailboxFolderTint("#ff0000")).toBeNull();
    expect(mailboxFolderTint("VIOLET")).toBeNull();
  });
});

describe("mailboxFolderOrderAfterMove", () => {
  const ids = ["a", "b", "c"];

  it("swaps a folder with its neighbour", () => {
    expect(mailboxFolderOrderAfterMove(ids, "b", "up")).toEqual(["b", "a", "c"]);
    expect(mailboxFolderOrderAfterMove(ids, "b", "down")).toEqual(["a", "c", "b"]);
    expect(mailboxFolderOrderAfterMove(ids, "c", "up")).toEqual(["a", "c", "b"]);
  });

  it("returns the same list when the move is impossible", () => {
    expect(mailboxFolderOrderAfterMove(ids, "a", "up")).toBe(ids);
    expect(mailboxFolderOrderAfterMove(ids, "c", "down")).toBe(ids);
    expect(mailboxFolderOrderAfterMove(ids, "zzz", "down")).toBe(ids);
  });
});
