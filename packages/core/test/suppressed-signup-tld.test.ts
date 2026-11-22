import { describe, expect, it } from "vitest";
import { suppressedSignupDomain } from "../src/signup-risk-signals.js";

describe("suppressed signup TLDs", () => {
  it("refuses the TLD the 19/11 wave abused", () => {
    expect(suppressedSignupDomain("n8qz90ewlu8@elkcrane.shop")).toBe(true);
    expect(suppressedSignupDomain("ywonj5o1@navyaqua.shop")).toBe(true);
    expect(suppressedSignupDomain("USER@Brand.SHOP")).toBe(true);
  });

  it("leaves ordinary domains alone", () => {
    expect(suppressedSignupDomain("jean@je4ndev.com")).toBe(false);
    expect(suppressedSignupDomain("alguem@shop.example.com")).toBe(false);
    expect(suppressedSignupDomain("nao-e-email")).toBe(false);
  });
});
