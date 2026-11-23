import { describe, expect, it } from "vitest";
import { suppressedSignupDomain } from "../src/signup-risk-signals.js";

describe("suppressed signup TLDs", () => {
  it("refuses blocked signup TLDs", () => {
    expect(suppressedSignupDomain("alice@blocked-one.shop")).toBe(true);
    expect(suppressedSignupDomain("bob@blocked-two.shop")).toBe(true);
    expect(suppressedSignupDomain("USER@Brand.SHOP")).toBe(true);
  });

  it("leaves ordinary domains alone", () => {
    expect(suppressedSignupDomain("user@example.com")).toBe(false);
    expect(suppressedSignupDomain("someone@shop.example.com")).toBe(false);
    expect(suppressedSignupDomain("not-an-email")).toBe(false);
  });
});
