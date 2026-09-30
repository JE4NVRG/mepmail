import { readFileSync } from "node:fs";
import { PLAN_RUNGS } from "@millionsend/core/plans";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { SignupCta } from "@/components/signup-cta";
import { estimateOverageCents } from "@/lib/billing-estimate";
import { PLANS } from "@/lib/landing-plans";
import { postAuthNext, withNext } from "@/lib/nav";
import { paidRung } from "@/lib/purchase-intent";
import { proxy } from "@/proxy";

vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));

// Regressão da expressão efetivamente renderizada; não simula cobrança Stripe.
const billing = readFileSync(
  new URL("../src/app/(dashboard)/settings/billing/billing-view.tsx", import.meta.url),
  "utf8",
);

describe("purchase funnel regression", () => {
  it.each(["starter", "pro_100k", "pro_200k"])("carries stable paid rung %s", (rung) => {
    const tree = SignupCta({ label: "Choose", plan: "analytics label", ...{ rung } });
    expect(tree.props.href).toBe(
      `/signup?next=${encodeURIComponent(`/settings/billing?rung=${rung}`)}`,
    );
  });
  it("keeps Free/general signup unchanged", () => {
    expect(SignupCta({ label: "Free", ...{ rung: "free" } }).props.href).toBe("/signup");
    expect(SignupCta({ label: "Signup" }).props.href).toBe("/signup");
  });
  it("maps every public card to the matching stable key", () => {
    expect(PLANS.map((plan) => (plan as unknown as { rung: string }).rung)).toEqual(
      PLAN_RUNGS.map((r) => r.key),
    );
  });
  it.each([0, 1, 999, 1000, 1001, 1999, 2000])(
    "rounds %i overage up to whole blocks using the subscription rate",
    (over) => {
      expect(billing).toContain("estimateOverageCents(over, quota.overageCentsPer1k)");
      for (const rate of [90, 35, 123]) {
        expect(estimateOverageCents(over, rate)).toBe(Math.ceil(over / 1000) * rate);
      }
    },
  );
  it.each([
    null,
    undefined,
    "",
    "free",
    "pro_110k",
    "pro_220k",
    ["pro_100k"],
    "https://evil.invalid",
    "__proto__",
  ])("ignores invalid paid rung %j", (value) => {
    expect(paidRung(value)).toBeNull();
  });
  it.each([
    "//evil.invalid",
    "/\\evil.invalid",
    "javascript:alert(1)",
    "https://evil.invalid",
    ["/emails"],
    "/login?next=/login",
    "/signup",
    "/onboarding?next=/onboarding",
    "/reset-password",
    "/%6cogin",
    "/%2fonboarding",
    "/%5cevil.invalid",
    "/api/auth/callback",
    "/\t//evil.invalid",
  ])("rejects unsafe/looping target %j", (value) => {
    expect(postAuthNext(value)).toBe("/emails");
    expect(withNext("/login", value)).toBe("/login");
  });
  it("overwrites the internal request target, never trusts a client header", () => {
    const response = proxy(
      new NextRequest("https://app.example.com/settings/billing?rung=pro_200k", {
        headers: { "x-mepmail-next": "https://evil.invalid", host: "app.example.com" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-mepmail-next")).toBe(
      "/settings/billing?rung=pro_200k",
    );
  });
});
