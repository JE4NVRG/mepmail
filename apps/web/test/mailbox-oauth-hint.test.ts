import { describe, expect, it } from "vitest";
import { mailboxOAuthLoginHint } from "@/lib/mailbox-oauth-hint";

/** Synthetic addresses only. */
describe("mailboxOAuthLoginHint", () => {
  it("hints Microsoft only with a Microsoft consumer address", () => {
    expect(mailboxOAuthLoginHint("microsoft", " Ana@Hotmail.com ")).toBe("ana@hotmail.com");
    expect(mailboxOAuthLoginHint("microsoft", "ana@outlook.com.br")).toBe("ana@outlook.com.br");
    expect(mailboxOAuthLoginHint("microsoft", "ana@live.com")).toBe("ana@live.com");
    expect(mailboxOAuthLoginHint("microsoft", "ana@empresa.com")).toBeNull();
    expect(mailboxOAuthLoginHint("microsoft", "ana@gmail.com")).toBeNull();
  });

  it("hints Google only with a Gmail address, and nothing for an empty or bad field", () => {
    expect(mailboxOAuthLoginHint("google", "ana@gmail.com")).toBe("ana@gmail.com");
    expect(mailboxOAuthLoginHint("google", "ana@empresa.com")).toBeNull();
    expect(mailboxOAuthLoginHint("google", "")).toBeNull();
    expect(mailboxOAuthLoginHint("microsoft", undefined)).toBeNull();
    expect(mailboxOAuthLoginHint("microsoft", "not an address")).toBeNull();
  });
});
