import { describe, expect, it } from "vitest";
import { customFolderOf, isSearchResultFolder, serverSearchTerm } from "./mailbox-search";

describe("mailbox search helpers", () => {
  it("asks the server from two characters, trimmed and with single spaces", () => {
    expect(serverSearchTerm("")).toBeNull();
    expect(serverSearchTerm(" a ")).toBeNull();
    expect(serverSearchTerm("  nota   fiscal ")).toBe("nota fiscal");
    expect(serverSearchTerm("de:maya tem:anexo")).toBe("de:maya tem:anexo");
    expect(serverSearchTerm("x".repeat(201))).toBeNull();
  });

  it("names where a result lives", () => {
    expect(isSearchResultFolder("sent")).toBe(true);
    expect(isSearchResultFolder("quarantine")).toBe(false);
    expect(customFolderOf("custom:3f1c")).toBe("3f1c");
    expect(customFolderOf("custom:")).toBeNull();
    expect(customFolderOf("inbox")).toBeNull();
    expect(customFolderOf(undefined)).toBeNull();
  });
});
