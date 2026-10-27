import { readFileSync } from "node:fs";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BillingSummaryPanel } from "@/app/(dashboard)/settings/billing/billing-summary-panel";
import type { BillingSummary } from "@/lib/billing-summary";

const start = "2026-10-01T00:00:00.000Z";
const end = "2026-11-01T00:00:00.000Z";
const later = "2026-12-01T00:00:00.000Z";
const catalogs = Object.fromEntries(
  ["en", "pt-BR"].map((locale) => [
    locale,
    JSON.parse(
      readFileSync(new URL(`../messages/${locale}/settings.json`, import.meta.url), "utf8"),
    ),
  ]),
);
function fixture(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    state: "confirmed",
    currentPeriodStart: start,
    currentPeriodEnd: end,
    renewalAt: end,
    accessEndsAt: null,
    nextInvoice: {
      at: end,
      currency: "usd",
      baseAmountCents: 2900,
      baseDiscountCents: 0,
      baseNetCents: 2900,
      totalEstimateCents: 3150,
      usageMayChange: true,
      periodStart: end,
      periodEnd: later,
    },
    benefit: null,
    ...overrides,
  };
}
function invoiceFixture(): NonNullable<BillingSummary["nextInvoice"]> {
  const invoice = fixture().nextInvoice;
  if (!invoice) throw new Error("Synthetic invoice fixture missing");
  return invoice;
}
function render(summary = fixture(), locale = "en", onRetry?: () => void) {
  const content = createElement(BillingSummaryPanel, {
    summary,
    locale,
    ...(onRetry ? { onRetry } : {}),
  });
  const providerProps = {
    locale,
    timeZone: "UTC",
    messages: { settings: catalogs[locale] ?? catalogs.en },
    children: content,
  };
  return renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps, content));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe.each(["en", "pt-BR"])("customer billing summary (%s)", (locale) => {
  const t = catalogs[locale].billing.summary;
  it("renders current period, next renewal and server-provided net base separately from estimate", () => {
    const html = render(fixture(), locale);
    expect(html).toContain(t.currentPeriod);
    expect(html).toContain(t.nextRenewal);
    expect(html).toContain(t.nextPlanCharge);
    expect(html).toContain(t.estimate);
    expect(html).toContain(t.usageNote);
    expect(html).toContain(
      new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(29),
    );
    expect(html).toContain(
      new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(31.5),
    );
    for (const iso of [start, end, later]) expect(html).toContain(`dateTime="${iso}"`);
    expect(html).not.toContain(t.courtesyBody);
  });
  it("uses access-until instead of renewal for a canceled subscription", () => {
    const html = render(fixture({ accessEndsAt: end, nextInvoice: null }), locale);
    expect(html).toContain(t.accessUntil);
    expect(html).toContain(t.notRenewing);
    expect(html).toContain(t.noRenewalCharge);
    expect(html).not.toContain(t.nextRenewal);
    expect(html).not.toContain(t.nextPlanCharge);
    expect(html).not.toContain(t.estimate);
  });
  it("shows an explicit courtesy period and only the known regular billing resume date", () => {
    const invoice = invoiceFixture();
    const html = render(
      fixture({
        nextInvoice: {
          ...invoice,
          baseDiscountCents: 2900,
          baseNetCents: 0,
          totalEstimateCents: 250,
        },
        benefit: {
          kind: "courtesy",
          periodStart: end,
          periodEnd: later,
          baseDiscountCents: 2900,
          regularBillingResumesAt: later,
        },
      }),
      locale,
    );
    expect(html).toContain(t.courtesy);
    expect(html).toContain(t.courtesyBody);
    expect(html).toContain(t.benefitPeriod);
    expect(html).toContain(t.regularResumes);
    expect(html).toContain(t.usageNote);
    expect(html).toContain(
      new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(2.5),
    );
    expect(html).not.toContain(t.discountBody);
  });
  it("does not invent a paid-resume date when the courtesy end is known but resume is not", () => {
    const html = render(
      fixture({
        nextInvoice: null,
        benefit: {
          kind: "courtesy",
          periodStart: start,
          periodEnd: end,
          baseDiscountCents: 2900,
          regularBillingResumesAt: null,
        },
      }),
      locale,
    );
    expect(html).toContain(t.courtesyBody);
    expect(html).not.toContain(t.regularResumes);
    expect(html).not.toContain(t.nextPlanCharge);
  });
  it("does not call a partial discount free and uses authoritative baseNetCents", () => {
    const invoice = invoiceFixture();
    const html = render(
      fixture({
        nextInvoice: {
          ...invoice,
          baseDiscountCents: 500,
          baseNetCents: 2400,
          totalEstimateCents: 2650,
        },
        benefit: {
          kind: "discount",
          periodStart: end,
          periodEnd: later,
          baseDiscountCents: 500,
          regularBillingResumesAt: null,
        },
      }),
      locale,
    );
    expect(html).toContain(t.discountBody);
    expect(html).not.toContain(t.courtesyBody);
    expect(html).not.toContain(t.regularResumes);
    expect(html).toContain(
      new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(24),
    );
  });
  it("does not infer courtesy just because the base is zero", () => {
    const invoice = invoiceFixture();
    const html = render(fixture({ nextInvoice: { ...invoice, baseNetCents: 0 } }), locale);
    expect(html).not.toContain(t.courtesyBody);
  });
  it("renders unavailable without leaking stale dates, prices or benefits", () => {
    const html = render(fixture({ state: "unavailable" }), locale);
    expect(html).toContain('role="status"');
    expect(html).toContain(t.unavailable);
    expect(html).toContain(t.reload);
    expect(html).not.toContain("dateTime=");
    expect(html).not.toContain(t.estimate);
    expect(html).not.toContain(t.nextPlanCharge);
    expect(html).not.toContain("29.00");
  });
  it("offers a native, enabled retry button only when recovery is wired", () => {
    const html = render(fixture({ state: "unavailable" }), locale, vi.fn());
    expect(html).toContain('type="button"');
    expect(html).toContain(t.retry);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(t.reload);
    expect(render(fixture(), locale, vi.fn())).not.toContain("<button");
  });
  it("renders nothing when billing is not applicable", () => {
    expect(render(fixture({ state: "not_applicable" }), locale)).toBe("");
  });
  it("states that the estimate is provisional even if usage is fixed", () => {
    const invoice = invoiceFixture();
    const html = render(fixture({ nextInvoice: { ...invoice, usageMayChange: false } }), locale);
    expect(html).toContain(t.estimateNote);
    expect(html).toContain(t.estimate);
  });
  it("formats the real currency, not a hardcoded USD or BRL substitution", () => {
    const invoice = invoiceFixture();
    const html = render(fixture({ nextInvoice: { ...invoice, currency: "eur" } }), locale);
    expect(html).toContain(
      new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(29),
    );
  });
  it("uses period-neutral wording even for an annual financial period", () => {
    const invoice = invoiceFixture();
    const html = render(
      fixture({ nextInvoice: { ...invoice, periodEnd: "2027-11-01T00:00:00.000Z" } }),
      locale,
    );
    expect(html).toContain(t.nextPlanCharge);
    expect(text(html)).not.toMatch(/per month|\/month|mensalidade|por mês/i);
  });
});

it("has a named region, semantic detail lists, machine-readable dates and wrapping layout", () => {
  const html = render();
  const headingId = /<h2 id="([^"]+)"/.exec(html)?.[1];
  expect(headingId).toBeTruthy();
  expect(html).toContain(`aria-labelledby="${headingId}"`);
  expect(html).toContain("<dl");
  expect(html).toContain("<dt");
  expect(html).toContain("<dd");
  expect(html).toContain("overflow-wrap:anywhere");
  expect(html).toContain("minmax(min(100%, 220px), 1fr)");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("<button");
});
it("handles missing or malformed dates without inventing a date or crashing", () => {
  const html = render(
    fixture({
      currentPeriodStart: "not-an-iso-date",
      currentPeriodEnd: null,
      renewalAt: null,
      nextInvoice: null,
    }),
  );
  expect(html).toContain(catalogs.en.billing.summary.dateUnavailable);
  expect(html).not.toContain("Invalid Date");
  expect(html).not.toContain("dateTime=");
});
it("uses an explicit UTC calendar date at midnight", () => {
  const html = render();
  expect(html).toContain("Nov 1, 2026");
  expect(html).toContain(catalogs.en.billing.summary.datesUtc);
});
it("falls back safely for a malformed formatting locale", () => {
  expect(render(fixture(), "invalid_locale")).toContain("Nov 1, 2026");
});
it("does not expose unexpected provider metadata or internal discount strings", () => {
  const model = Object.assign(fixture(), {
    customerId: "cus_private",
    coupon: "operator-courtesy",
    reason: "internal-reason",
  });
  const html = render(model);
  for (const forbidden of ["cus_private", "operator-courtesy", "internal-reason"])
    expect(html).not.toContain(forbidden);
});
it("has matching EN/PT summary keys and complete translated visible copy", () => {
  const en = catalogs.en.billing.summary;
  const pt = catalogs["pt-BR"].billing.summary;
  expect(Object.keys(en).sort()).toEqual(Object.keys(pt).sort());
  for (const value of Object.values(pt))
    expect(typeof value === "string" && value.length > 0).toBe(true);
});
