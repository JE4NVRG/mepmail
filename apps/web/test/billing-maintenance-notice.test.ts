import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enCorreio from "../messages/en/correio.json";
import enSettings from "../messages/en/settings.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptSettings from "../messages/pt-BR/settings.json";
import { BillingView } from "../src/app/(dashboard)/settings/billing/billing-view";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  mutationIndex: 0,
  failedIndex: 0,
  code: "SERVICE_UNAVAILABLE" as string | null,
  failed: true,
}));
vi.mock("next-intl", () => ({
  useLocale: () => h.locale,
  useTranslations: (namespace: string) => (key: string) => {
    const messages = h.locale === "en" ? enSettings : ptSettings;
    if (namespace === "settings.billing" && key === "billingPaused")
      return messages.billing.billingPaused;
    if (namespace === "settings.billing" && key === "error") return messages.billing.error;
    return key;
  },
}));
vi.mock("@/lib/trpc", () => {
  const operation = {
    queryOptions: () => ({}),
    queryFilter: () => ({}),
    mutationOptions: () => ({}),
  };
  return {
    useTRPC: () => ({
      billing: {
        status: { ...operation, queryOptions: () => ({ status: true }) },
        checkout: operation,
        portal: operation,
        changePlan: operation,
        setOverage: operation,
      },
      team: { list: operation },
      settings: { usage: { recent: operation } },
    }),
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { status?: boolean }) => ({
    data: options.status
      ? {
          effectiveRung: null,
          plan: "free",
          planQuota: null,
          rung: "free",
          pendingRung: null,
          planStatus: "none",
          currentPeriodEnd: null,
          quota: { kind: "day", limit: 100, overage: false },
          usage: { accepted: 0 },
          hasCustomer: false,
          hasLiveSubscription: false,
          billingInterval: null,
          subscriptionState: "none",
          launchOffer: null,
        }
      : { activeTeamId: "fixture", teams: [{ teamId: "fixture", role: "owner" }] },
  }),
  useMutation: () => {
    const affected = h.mutationIndex++ === h.failedIndex;
    return {
      mutate: vi.fn(),
      isPending: false,
      isError: affected && h.failed,
      error: affected
        ? { message: "Synthetic private provider payload", data: h.code ? { code: h.code } : null }
        : null,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/modal", () => ({ Modal: () => null }));
vi.mock("@/components/odometer", () => ({ Odometer: () => null }));
vi.mock("../src/app/(dashboard)/settings/usage/usage-view", () => ({ QuotaRow: () => null }));

beforeEach(() => {
  h.mutationIndex = 0;
  h.failedIndex = 0;
  h.code = "SERVICE_UNAVAILABLE";
  h.failed = true;
});
const render = () => renderToStaticMarkup(createElement(BillingView, { checkout: null }));

describe.each(["en", "pt-BR"] as const)("billing maintenance notice in %s", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });
  const messages = locale === "en" ? enSettings : ptSettings;
  it.each(["checkout", "portal", "changePlan", "setOverage"])(
    "renders the specific accessible notice for paused %s without exposing provider payloads",
    (operation) => {
      h.failedIndex = ["checkout", "portal", "changePlan", "setOverage"].indexOf(operation);
      const html = render();
      expect(h.mutationIndex).toBe(4);
      expect(html).toContain('role="alert"');
      expect(html).toContain(messages.billing.billingPaused);
      expect(html).not.toContain(messages.billing.error);
      expect(html).not.toContain("Synthetic private provider payload");
    },
  );
  it.each(["BAD_REQUEST", null])("retains the generic notice for other errors (%s)", (code) => {
    h.code = code;
    const html = render();
    expect(html).toContain(messages.billing.error);
    expect(html).not.toContain(messages.billing.billingPaused);
  });
  it("does not present stale error data as an active failure", () => {
    h.failed = false;
    const html = render();
    expect(html).not.toContain(messages.billing.billingPaused);
    expect(html).not.toContain(messages.billing.error);
    expect(html).not.toContain('role="alert"');
  });
});

it.each([enCorreio, ptCorreio])(
  "describes only supported To and Cc recipient deliveries",
  (messages) => {
    expect(messages.preview.recipients).toContain("To");
    expect(messages.preview.recipients).toContain("Cc");
    expect(messages.preview.recipients).not.toMatch(/\bBcc\b/i);
  },
);
