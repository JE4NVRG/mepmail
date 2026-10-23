import type { PurchaseEligibility } from "@millionsend/billing";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DomainSafetyNotice,
  type DomainSafetyNoticeInput,
  domainSafetyNotice,
} from "@/components/domain-safety-notice";
import en from "../messages/en/domains.json";
import pt from "../messages/pt-BR/domains.json";

type Code = PurchaseEligibility["code"];
const eligibility = (code: Code, eligible = code === "ready") => ({ code, eligible });
function render(locale: "en" | "pt-BR", input: DomainSafetyNoticeInput) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { domains: locale === "en" ? en : pt },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(DomainSafetyNotice, input),
    }),
  );
}

describe("verified DNS and sending security are separate facts", () => {
  it.each(["en", "pt-BR"] as const)(
    "%s confirms ordinary verified DNS without promising sending or requiring payment",
    (locale) => {
      const input = { eligibility: eligibility("ready") };
      expect(domainSafetyNotice(input)).toMatchObject({ state: "ready", variant: "success" });
      const text = render(locale, input);
      expect(text).toContain(locale === "en" ? "DNS verified." : "DNS verificado.");
      expect(text).toContain(locale === "en" ? "security checks" : "verificações de segurança");
      expect(text).not.toMatch(
        /Ready to send|Pronto para enviar|subscribe|subscription|purchase|assinar|pagar|comprar/i,
      );
    },
  );

  it.each([
    ["domain_review", "domainReview"],
    ["send_review", "review"],
    ["signup_review", "review"],
    ["signup_sandbox", "sandbox"],
    ["suspended", "suspended"],
    ["guardrail_paused", "paused"],
  ] as const)("keeps %s visible after DNS verification", (code, state) => {
    expect(domainSafetyNotice({ eligibility: eligibility(code) })).toMatchObject({
      state,
      variant: "warn",
    });
    for (const locale of ["en", "pt-BR"] as const) {
      const html = render(locale, { eligibility: eligibility(code) });
      const copy = locale === "en" ? en : pt;
      expect(html).toContain(copy.detail.security[state]);
      expect(html).not.toMatch(/Ready to send|Pronto para enviar/);
    }
  });

  it("does not turn a failed or pending preflight into security clearance, including cached ready data", () => {
    expect(domainSafetyNotice({ error: true, eligibility: eligibility("ready") }).state).toBe(
      "unavailable",
    );
    expect(domainSafetyNotice({ pending: true, eligibility: eligibility("ready") }).state).toBe(
      "checking",
    );
    expect(domainSafetyNotice({}).state).toBe("checking");
    expect(domainSafetyNotice({ eligibility: eligibility("ready", false) }).state).toBe(
      "unavailable",
    );
    expect(domainSafetyNotice({ eligibility: eligibility("forbidden") }).state).toBe("unavailable");
    expect(domainSafetyNotice({ eligibility: eligibility("not_found") }).state).toBe("unavailable");
  });

  it("keeps a stale domain_required response unconfirmed until the post-verification refetch", () => {
    const before = domainSafetyNotice({ eligibility: eligibility("domain_required") });
    expect(before).toMatchObject({ state: "checking", variant: "warn" });
    expect(domainSafetyNotice({ eligibility: eligibility("domain_review") })).toMatchObject({
      state: "domainReview",
      variant: "warn",
    });
    expect(domainSafetyNotice({ eligibility: eligibility("ready") })).toMatchObject({
      state: "ready",
      variant: "success",
    });
  });

  it.each(["en", "pt-BR"] as const)(
    "%s preserves self-hosted DNS confirmation without billing",
    (locale) => {
      const input = { enabled: false, error: true };
      expect(domainSafetyNotice(input)).toMatchObject({ state: "dnsOnly", variant: "success" });
      expect(render(locale, input)).not.toMatch(
        /subscribe|subscription|purchase|assinar|pagar|comprar/i,
      );
    },
  );

  it("keeps both locale contracts complete and removes the DNS-only sending promise from the legacy fallback", () => {
    expect(Object.keys(en.detail.security).sort()).toEqual(Object.keys(pt.detail.security).sort());
    expect(en.detail.bannerVerifiedBody).not.toMatch(/Ready to send/i);
    expect(pt.detail.bannerVerifiedBody).not.toMatch(/Pronto para enviar/i);
  });
});
