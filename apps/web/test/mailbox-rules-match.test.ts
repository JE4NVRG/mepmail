import { describe, expect, it } from "vitest";
import {
  normalizeRuleValue,
  ruleCovers,
  senderDomain,
  validRuleValue,
} from "../src/lib/mailbox-rules-match";

describe("Regras automáticas on the client", () => {
  it("normalizes a match as the server keeps it", () => {
    expect(normalizeRuleValue("sender", "  Alerts@HealthChecks.io ")).toBe(
      "alerts@healthchecks.io",
    );
    expect(normalizeRuleValue("domain", " @HealthChecks.io. ")).toBe("healthchecks.io");
    expect(normalizeRuleValue("domain", "@@mail.google.com..")).toBe("mail.google.com");
  });

  it("accepts only addresses and domains the server would", () => {
    expect(validRuleValue("sender", "alerts@healthchecks.io")).toBe(true);
    expect(validRuleValue("sender", "healthchecks.io")).toBe(false);
    expect(validRuleValue("domain", "healthchecks.io")).toBe(true);
    expect(validRuleValue("domain", "mail.google.com")).toBe(true);
    expect(validRuleValue("domain", "localhost")).toBe(false);
    expect(validRuleValue("domain", "a@b.com")).toBe(false);
    expect(validRuleValue("domain", "-bad.com")).toBe(false);
  });

  it("covers the exact sender, or a domain with its subdomains", () => {
    const sender = { kind: "sender" as const, value: "alerts@healthchecks.io" };
    expect(ruleCovers(sender, "Alerts@HealthChecks.io")).toBe(true);
    expect(ruleCovers(sender, "other@healthchecks.io")).toBe(false);
    const domain = { kind: "domain" as const, value: "google.com" };
    expect(ruleCovers(domain, "noreply@google.com")).toBe(true);
    expect(ruleCovers(domain, "noreply@mail.google.com")).toBe(true);
    // A look-alike is not a subdomain.
    expect(ruleCovers(domain, "noreply@notgoogle.com")).toBe(false);
    expect(ruleCovers(domain, "google.com")).toBe(false);
  });

  it("reads the domain of an address", () => {
    expect(senderDomain("Jean@JE4NDEV.com")).toBe("je4ndev.com");
    expect(senderDomain("no-at-sign")).toBe("");
  });
});
