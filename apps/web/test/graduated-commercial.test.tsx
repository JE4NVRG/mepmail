import { readFileSync } from "node:fs";
import { PLAN_RUNGS } from "@millionsend/core/plans";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  beginSendCheckout,
  beginSendPixCheckout,
} from "../../../packages/billing/src/send-checkout";
import { sendNewPurchaseAvailability } from "../../../packages/billing/src/send-launch-offer";
import en from "../messages/en/landing.json";
import enSettings from "../messages/en/settings.json";
import pt from "../messages/pt-BR/landing.json";
import ptSettings from "../messages/pt-BR/settings.json";
import { SendingWarmupNotice } from "../src/app/(dashboard)/settings/billing/billing-view";
import { PlanCard } from "../src/components/plan-card";
import { ReputationPanel, type ReputationSnapshot } from "../src/components/reputation-panel";
import { recommendedDomainRegion } from "../src/lib/domain-region-recommendation";
import { PLANS, plansWithCopy } from "../src/lib/landing-plans";
import {
  LAUNCH_OFFER,
  sendingAvailabilityCopy,
  sendingOfferAvailability,
} from "../src/lib/launch-offer";

const ctx = vi.hoisted(() => ({ locale: "en" }));
vi.mock("next-intl", () => ({
  useLocale: () => ctx.locale,
  useTranslations: () => (key: keyof typeof enSettings.billing) =>
    (ctx.locale === "pt-BR" ? ptSettings : enSettings).billing[key],
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: () => {} }));
vi.mock("@/components/signup-cta", () => ({
  SignupCta: (p: { rung: string; label: string }) =>
    createElement("a", { href: "/signup?plan=" + p.rung }, p.label),
}));
vi.mock("@/components/signup-availability", () => ({ useClosedSignupLabel: () => null }));
const snapshot: ReputationSnapshot = {
  state: "verified",
  nominalPlanDaily: 3667,
  effectiveDaily: 100,
  effectiveMinute: 10,
  usedToday: 0,
  volume24h: 1000,
  complaints: { count: 1, denominator: 1000 },
  bounces: { count: 50, denominator: 1000 },
  newRecipients: { hour: 0, day: 0, week: 0 },
  warmupPercent: 25,
  nextDailyLimit: 1834,
  nextEligibleAt: "2026-11-22T00:00:00Z",
  campaignEligible: false,
  capacityKnown: true,
  refusal: null,
};
const labels = {
  perMonth: "/month",
  limitsLabel: "Limits",
  overageLabel: "Overage",
  attachmentLabel: "Attachments",
  cta: "Choose",
  ctaNote: "Terms",
  featuredBadge: "Featured",
};
describe("graduated commercial and customer reputation", () => {
  for (const locale of ["en", "pt-BR"]) {
    it(`${locale} discloses new-domain warm-up before purchase without resetting existing contracts`, () => {
      ctx.locale = locale;
      const html = renderToStaticMarkup(createElement(SendingWarmupNotice));
      const copy = (locale === "pt-BR" ? ptSettings : enSettings).billing;
      expect(html).toContain(copy.gradualSending);
      expect(html).toContain(copy.gradualSendingLink);
      expect(html).toContain('href="/domains"');
      expect(html).toContain("25%");
      expect(html).toContain("7");
      const source = readFileSync(
        new URL("../src/app/(dashboard)/settings/billing/billing-view.tsx", import.meta.url),
        "utf8",
      );
      const body = source.slice(source.indexOf("export function BillingView"));
      expect(body.indexOf("<SendingWarmupNotice />")).toBeLessThan(
        body.indexOf('<Card\n        title={t("plan")}'),
      );
      expect(body).toContain('<div className="ms-plan-dialog">\n          <SendingWarmupNotice />');
      expect(html).not.toMatch(/CommandCode|RPM|SLA/);
    });
  }
  it("new domain prefers healthy us-east-1, preserving explicit selections and existing regions", () => {
    const regions = [
      { code: "eu-west-1", production: true, sendingHealthy: true },
      { code: "us-east-1", production: true, sendingHealthy: true },
    ];
    expect(recommendedDomainRegion(regions)).toBe("us-east-1");
    expect(recommendedDomainRegion(regions, "eu-west-1")).toBe("eu-west-1");
    expect(recommendedDomainRegion([])).toBe("");
    expect(recommendedDomainRegion([{ ...regions[1]!, sendingHealthy: false }, regions[0]!])).toBe(
      "eu-west-1",
    );
  });
  for (const locale of ["en", "pt-BR"]) {
    for (const state of [
      "unverified",
      "verified",
      "domain_verified",
      "established",
      "suspended",
    ] as const)
      it(`${locale} renders actual panel ${state} with rolling denominators`, () => {
        const html = renderToStaticMarkup(
          createElement(ReputationPanel, {
            locale,
            status: "ready",
            snapshot: { ...snapshot, state },
          }),
        );
        expect(html).toContain("24h");
        expect(html).toContain("1 / 1");
        expect(html).not.toContain("NaN");
        expect(html).not.toContain("Infinity");
        expect(html).toContain(locale === "en" ? "Read-only" : "somente leitura");
      });
    for (const status of ["loading", "error", "forbidden", "unavailable"] as const)
      it(`${locale} ${status} never fabricates a metric`, () => {
        const html = renderToStaticMarkup(createElement(ReputationPanel, { locale, status }));
        expect(html).toContain('role="status"');
        expect(html).not.toContain("3667");
        expect(html).not.toContain("1,000");
      });
    for (const state of [
      "domain_required",
      "recipient_restricted",
      "daily_limit",
      "capacity_unknown",
      "review_required",
    ] as const)
      it(`${locale} readable refusal ${state} without tenant IDs or body`, () => {
        const html = renderToStaticMarkup(
          createElement(ReputationPanel, {
            locale,
            status: "ready",
            snapshot: { ...snapshot, refusal: state },
          }),
        );
        expect(html).toContain('role="status"');
        expect(html).not.toContain(state);
      });
    for (const launch of [true, false])
      for (const currency of ["usd", "brl"] as const)
        it(`${locale} every offer ID ${currency} launch=${launch} keeps catalog and gates acquisitions`, () => {
          ctx.locale = locale;
          const plans = plansWithCopy(
            (locale === "en" ? en : pt).plans.items,
            launch,
            undefined,
            currency,
          );
          expect(plans.map((x) => x.rung)).toEqual(PLANS.map((x) => x.rung));
          for (const plan of plans) {
            const html = renderToStaticMarkup(
              createElement(PlanCard, { plan: { ...plan, locale }, labels }),
            );
            expect(sendingOfferAvailability(plan.rung)).toBe(
              sendNewPurchaseAvailability(plan.rung),
            );
            const catalog = PLAN_RUNGS.find((rung) => rung.key === plan.rung);
            if (!catalog) throw new Error("Every rendered offer requires a catalog rung");
            expect(sendingOfferAvailability(catalog.included)).toBe(
              sendNewPurchaseAvailability(plan.rung),
            );
            if (sendingOfferAvailability(plan.rung) === "enterprise") {
              expect(html).toContain(sendingAvailabilityCopy(locale).enterprise);
              expect(html).not.toContain("/signup");
              expect(html).not.toContain(plan.price);
            } else {
              expect(html).toContain(plan.price);
              expect(html).toContain("/signup");
            }
          }
          expect(LAUNCH_OFFER.sending.monthlyCents).toBe(2900);
          expect(LAUNCH_OFFER.sending.brlMonthlyCents).toBe(14900);
        });
  }
  for (const value of [null, Number.NaN, Infinity, -1, 0.5])
    it(`unknown/unsafe count ${value} is not zero or unlimited`, () => {
      const html = renderToStaticMarkup(
        createElement(ReputationPanel, {
          locale: "en",
          status: "ready",
          snapshot: {
            ...snapshot,
            complaints: { count: value, denominator: null },
            capacityKnown: false,
            effectiveDaily: 999999,
            nextEligibleAt: "<img src=x onerror=alert(1)>",
          },
        }),
      );
      expect(html).toContain("Unknown");
      expect(html).not.toContain("999,999");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("NaN");
    });
  it("zero events with positive denominator is measured zero; zero denominator is unknown", () => {
    const a = renderToStaticMarkup(
      createElement(ReputationPanel, {
        locale: "en",
        status: "ready",
        snapshot: {
          ...snapshot,
          complaints: { count: 0, denominator: 100 },
          bounces: { count: 0, denominator: 0 },
        },
      }),
    );
    expect(a).toContain("0% · 0 / 100");
    expect(a).toContain("Unknown · 0 / 0");
  });
  for (const rung of ["scale_1_5m", "scale_2_5m"] as const)
    for (const method of ["card", "pix"])
      it(`${method} direct bypass ${rung} fails before DB/provider calls`, async () => {
        const touched: string[] = [];
        const trap = new Proxy(
          {},
          {
            get(_t, k) {
              touched.push(String(k));
              throw new Error("no side effects permitted");
            },
          },
        );
        const deps = { db: trap, stripe: trap, livemode: false };
        const input = {
          rung,
          team: { id: "fixture", name: "Fixture", stripeCustomerId: null },
          userId: "fixture",
          email: "fixture@example.test",
          successUrl: "https://example.test/success",
          cancelUrl: "https://example.test/cancel",
        };
        const promise =
          method === "card"
            ? beginSendCheckout(deps as never, input)
            : beginSendPixCheckout(deps as never, trap as never, input);
        await expect(promise).rejects.toMatchObject({ code: "invalid" });
        expect(touched).toEqual([]);
      });
  it("existing high-tier catalog contracts remain nominal and priced", () => {
    expect(PLAN_RUNGS.find((r) => r.key === "scale_1_5m")).toMatchObject({
      included: 1650000,
      priceCents: 34900,
    });
    expect(PLAN_RUNGS.find((r) => r.key === "scale_2_5m")).toMatchObject({
      included: 2750000,
      priceCents: 54900,
    });
  });
  it("only the two consultation tiers are statically closed, by catalog key and included volume", () => {
    for (const rung of PLAN_RUNGS) {
      const expected = ["scale_1_5m", "scale_2_5m"].includes(rung.key)
        ? "enterprise"
        : "self_serve";
      expect(sendNewPurchaseAvailability(rung.key)).toBe(expected);
      expect(sendingOfferAvailability(rung.key)).toBe(expected);
      expect(sendingOfferAvailability(rung.included)).toBe(expected);
    }
  });
  it("billing source fences purchases, not reductions or existing-plan management", () => {
    // Source contract only; rendered interaction coverage remains a separate Linux/browser gate.
    const source = readFileSync(
      new URL("../src/app/(dashboard)/settings/billing/billing-view.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('(!needsPurchaseReview || availability !== "enterprise")');
    expect(source.match(/\(needsPurchaseReview && salesPaused\)/g)).toHaveLength(2);
    expect(source).toContain('!isCurrent && needsPurchaseReview && availability === "enterprise"');
    expect(source).toContain("isCurrent || !needsPurchaseReview");
  });
});
