import { describe, expect, it } from "vitest";
import { requestedMailboxPurchase, requestedPlan } from "@/lib/public-intent";
import {
  billingPurchaseReturn,
  mailboxPurchaseReturn,
  purchaseDomainReviewHref,
  purchaseReturnPath,
  withPurchaseReturn,
} from "@/lib/purchase-return";

describe("domain review round trip", () => {
  it("carries Equipe through the domain list, creation, refresh and DNS detail", () => {
    const intended = mailboxPurchaseReturn("equipe");
    let next = new URL(purchaseDomainReviewHref(intended), "https://app.test").searchParams.get(
      "next",
    );
    for (const path of [
      "/domains/new",
      "/domains/new?created=domain-1",
      "/domains/domain-1",
      "/domains",
    ]) {
      const url = new URL(withPurchaseReturn(path, next), "https://app.test");
      next = purchaseReturnPath(url.searchParams.get("next"));
      expect(next).toBe(intended);
      if (url.pathname === "/domains/new" && url.searchParams.has("created"))
        expect(url.searchParams.get("created")).toBe("domain-1");
    }
    const returned = new URL(next!, "https://app.test");
    expect(requestedMailboxPurchase(Object.fromEntries(returned.searchParams))).toEqual({
      plan: "equipe",
    });
  });

  it("restores the chosen Send rung and annual period, without a fake payment return", () => {
    const selected = billingPurchaseReturn({ plan: "pro_100k", interval: "year", correio: true });
    const pending = new URL(
      purchaseDomainReviewHref(`${selected}&checkout=success&pix=paid`),
      "https://app.test",
    );
    const returned = new URL(pending.searchParams.get("next")!, "https://app.test");
    expect(requestedPlan(Object.fromEntries(returned.searchParams))).toBe("pro_100k");
    expect(returned.searchParams.get("interval")).toBe("year");
    expect(returned.searchParams.get("correio")).toBe("1");
    expect(returned.searchParams.has("checkout")).toBe(false);
    expect(returned.searchParams.has("pix")).toBe(false);
  });

  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/domains",
    "/settings/billing#pay",
    "/%2f%2fevil.test",
    "/mail\n",
    "javascript:alert(1)",
  ])("rejects an untrusted return %s", (value) => {
    expect(purchaseReturnPath(value)).toBeNull();
    expect(
      new URL(purchaseDomainReviewHref(value), "https://app.test").searchParams.get("next"),
    ).toBe("/settings/billing");
  });

  it("keeps ordinary domain navigation unchanged without purchase intent", () => {
    expect(withPurchaseReturn("/domains/new?created=one", null)).toBe("/domains/new?created=one");
    expect(mailboxPurchaseReturn("unknown")).toBe("/mail?setup=correio");
  });
});
