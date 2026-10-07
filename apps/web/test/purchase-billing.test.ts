import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatUsd } from "@/lib/format";
import { BillingView } from "../src/app/(dashboard)/settings/billing/billing-view";

const h = vi.hoisted(() => ({
  locale: "en",
  rate: 123 as number | null,
  role: "owner",
  mutate: vi.fn(),
  translations: [] as { key: string; values: Record<string, unknown> }[],
  subscribed: true,
  launchEnabled: false,
  period: "month" as "month" | "year",
  billingInterval: "month" as "month" | "year",
  subscriptionState: "confirmed" as "confirmed" | "pending_confirmation",
  pendingRung: null as string | null,
  system: false,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial === "month" ? h.period : initial, vi.fn()],
  // The view is called as a plain function here; effects (the saved combo
  // intent) belong to the browser and are not under test.
  useEffect: () => undefined,
}));
vi.mock("next-intl", () => ({
  useLocale: () => h.locale,
  useTranslations:
    () =>
    (key: string, values: Record<string, unknown> = {}) => {
      h.translations.push({ key, values });
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
        status: { queryOptions: () => ({ fixture: "status" }), queryFilter: () => ({}) },
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
  useQuery: (options: { fixture?: string }) => ({
    data: options.fixture
      ? {
          effectiveRung:
            h.subscribed && h.subscriptionState === "confirmed"
              ? { key: "pro_100k", priceCents: h.billingInterval === "year" ? 29000 : 2000 }
              : null,
          plan: h.system ? "system" : h.subscribed ? "pro" : "free",
          planQuota: h.subscribed ? 110000 : null,
          rung: h.subscribed ? "pro_100k" : "free",
          pendingRung: h.pendingRung,
          planStatus: "active",
          currentPeriodEnd: h.pendingRung ? new Date("2027-10-01") : null,
          quota: {
            kind: "month",
            included: 110000,
            periodEnd: new Date("2026-10-01"),
            overage: true,
            overageCentsPer1k: h.rate,
          },
          usage: { accepted: 111001 },
          hasCustomer: true,
          hasLiveSubscription: h.subscribed,
          billingInterval: h.billingInterval,
          subscriptionState: h.subscriptionState,
          launchOffer: h.launchEnabled
            ? {
                rung: "pro_100k",
                monthlyCents: 2900,
                firstMonthlyCents: 2000,
                annualCents: 29000,
                monthlyRecipientDeliveries: 110000,
              }
            : null,
        }
      : { activeTeamId: "fixture", teams: [{ teamId: "fixture", role: h.role }] },
  }),
  useMutation: () => ({ mutate: h.mutate }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../src/app/(dashboard)/settings/usage/usage-view", () => ({ QuotaRow: () => null }));
vi.mock("@/components/modal", () => ({ Modal: () => null }));
vi.mock("@/components/odometer", () => ({ Odometer: () => null }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
beforeEach(() => {
  h.mutate.mockClear();
  h.translations = [];
  h.role = "owner";
  h.rate = 123;
  h.locale = "en";
  h.subscribed = true;
  h.launchEnabled = false;
  h.period = "month";
  h.billingInterval = "month";
  h.subscriptionState = "confirmed";
  h.pendingRung = null;
  h.system = false;
});

describe("billing selection synthetic UI contract, not paid E2E", () => {
  it("shows legacy USD20 and chooses its monthly checkout when the launch flag is disabled", () => {
    h.subscribed = false;
    const tree = BillingView({ checkout: null, requestedRung: "pro_100k" });
    const prices = nodes(tree).filter((n) => typeof n.props.formatted === "string");
    expect(prices.some((n) => n.props.formatted === formatUsd(2000, "en"))).toBe(true);
    expect(prices.some((n) => n.props.formatted === formatUsd(2900, "en"))).toBe(false);
    expect(h.translations.some((t) => t.key.startsWith("launch."))).toBe(false);
    const choose = nodes(tree).find(
      (n) => n.type === "button" && n.props.className === "ms-btn ms-btn-primary",
    );
    if (!choose) throw new Error("Missing legacy checkout action");
    (choose.props.onClick as () => void)();
    expect(h.mutate).toHaveBeenCalledWith({ rung: "pro_100k", interval: "month" });
  });

  it.each(["en", "pt-BR"])(
    "presents monthly first-bill and renewal terms for the enabled new offer in %s",
    (locale) => {
      h.locale = locale;
      h.subscribed = false;
      h.launchEnabled = true;
      const tree = BillingView({ checkout: null });
      const radios = nodes(tree).filter(
        (n) => n.type === "input" && n.props.name === "send-launch-interval",
      );
      expect(radios).toHaveLength(2);
      expect(radios.map((n) => [n.props.value, n.props.checked])).toEqual([
        ["month", true],
        ["year", false],
      ]);
      expect(h.translations.find((t) => t.key === "launch.monthlyTerms")?.values).toEqual({
        first: formatUsd(2000, locale),
        renewal: formatUsd(2900, locale),
      });
      const action = nodes(tree).find(
        (n) =>
          n.type === "button" &&
          nodes(n.props.children as ReactNode).length === 1 &&
          (n.props.children as ReactNode[]).includes("launch.continue"),
      );
      if (!action) throw new Error("Missing explicit new-offer checkout action");
      expect(h.mutate).not.toHaveBeenCalled();
      (action.props.onClick as () => void)();
      expect(h.mutate).toHaveBeenCalledWith({ rung: "pro_100k", interval: "month" });
    },
  );

  it("presents upfront annual payment and carries year to checkout without showing the monthly promotion", () => {
    h.subscribed = false;
    h.launchEnabled = true;
    h.period = "year";
    const tree = BillingView({ checkout: null });
    expect(h.translations.find((t) => t.key === "launch.annualTerms")?.values).toEqual({
      total: formatUsd(29000, "en"),
      equivalent: formatUsd(2417, "en"),
    });
    expect(h.translations.some((t) => t.key === "launch.monthlyTerms")).toBe(false);
    const action = nodes(tree).find(
      (n) =>
        n.type === "button" &&
        Array.isArray(n.props.children) &&
        n.props.children.includes("launch.continue"),
    );
    if (!action) throw new Error("Missing explicit annual checkout action");
    expect(h.mutate).not.toHaveBeenCalled();
    (action.props.onClick as () => void)();
    expect(h.mutate).toHaveBeenCalledWith({ rung: "pro_100k", interval: "year" });
  });

  it.each(["disabled", "existing", "system", "member"] as const)(
    "preserves the %s guard of the new-offer controls",
    (guard) => {
      h.subscribed = guard === "existing";
      h.launchEnabled = guard !== "disabled";
      h.system = guard === "system";
      h.role = guard === "member" ? "member" : "owner";
      const tree = BillingView({ checkout: null });
      const action = nodes(tree).find(
        (n) =>
          n.type === "button" &&
          Array.isArray(n.props.children) &&
          n.props.children.includes("launch.continue"),
      );
      expect(action).toBeUndefined();
      if (guard !== "member")
        expect(
          nodes(tree).some((n) => n.type === "input" && n.props.name === "send-launch-interval"),
        ).toBe(false);
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it("labels the existing annual base price yearly and disables automatic overage", () => {
    h.billingInterval = "year";
    const tree = BillingView({ checkout: null });
    expect(h.translations.find((t) => t.key === "effectiveAnnualBasePrice")?.values.price).toBe(
      formatUsd(29000, "en"),
    );
    expect(h.translations.some((t) => t.key === "launch.annualHardCap")).toBe(true);
    const toggle = nodes(tree).find((n) => n.props.ariaLabel === "overage");
    expect(toggle?.props.disabled).toBe(true);
  });

  it.each(["annual", "pending"] as const)(
    "disables plan changes and pending-change reversal for %s terms while preserving the portal",
    (guard) => {
      if (guard === "annual") h.billingInterval = "year";
      else h.subscriptionState = "pending_confirmation";
      h.pendingRung = "starter";
      const tree = BillingView({ checkout: null, requestedRung: "pro_200k" });
      const planAction = nodes(tree).find(
        (n) => n.type === "button" && n.props.className === "ms-btn ms-btn-primary",
      );
      const keep = nodes(tree).find(
        (n) =>
          n.type === "button" &&
          Array.isArray(n.props.children) &&
          n.props.children.includes("keepPlan"),
      );
      expect(planAction?.props.disabled).toBe(true);
      if (!planAction) throw new Error("Missing disabled plan action");
      (planAction.props.onClick as () => void)();
      expect(keep?.props.disabled).toBe(true);
      expect(keep?.props.onClick).toBeUndefined();
      expect(nodes(tree).find((n) => n.props.ariaLabel === "overage")?.props.disabled).toBe(true);
      expect(
        h.translations.some(
          (t) =>
            t.key ===
            (guard === "annual" ? "annualChangesUnavailable" : "subscriptionConfirmationPending"),
        ),
      ).toBe(true);
      if (guard === "pending")
        expect(
          h.translations.some(
            (t) => t.key === "effectiveBasePrice" || t.key === "effectiveAnnualBasePrice",
          ),
        ).toBe(false);
      const portal = nodes(tree).find(
        (n) =>
          n.type === "button" &&
          Array.isArray(n.props.children) &&
          n.props.children.includes("manage"),
      );
      expect(portal?.props.disabled).toBeFalsy();
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it("hides the monetary estimate when the subscription rate is unavailable", () => {
    h.rate = null;
    BillingView({ checkout: null });
    expect(h.translations.some((t) => t.key === "effectiveRateUnavailable")).toBe(true);
    expect(h.translations.some((t) => t.key === "overSoFar")).toBe(false);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  for (const locale of ["en", "pt-BR"]) {
    it.each(["starter", "pro_100k", "pro_200k"] as const)(
      `${locale} selects %s without mutation and keeps subscription overage rate`,
      (requestedRung) => {
        h.locale = locale;
        const tree = BillingView({ checkout: null, requestedRung });
        const slider = nodes(tree).find((n) => n.props.id === "ms-volume");
        expect(slider?.props.value).toBe({ starter: 1, pro_100k: 2, pro_200k: 3 }[requestedRung]);
        expect(nodes(tree).some((n) => n.props.open === true)).toBe(true);
        expect(h.mutate).not.toHaveBeenCalled();
        expect(h.translations.find((t) => t.key === "effectiveBasePrice")?.values.price).toBe(
          formatUsd(2000, locale),
        );
        expect(h.translations.find((t) => t.key === "overSoFar")?.values.amount).toBe(
          formatUsd(246, locale),
        );
      },
    );
  }
  it("only an explicit owner click changes the selected plan", () => {
    const tree = BillingView({ checkout: null, requestedRung: "pro_200k" });
    const button = nodes(tree).find(
      (n) => n.type === "button" && n.props.className === "ms-btn ms-btn-primary",
    );
    expect(h.mutate).not.toHaveBeenCalled();
    if (!button) throw new Error("Expected owner action");
    (button.props.onClick as () => void)();
    expect(h.mutate).toHaveBeenCalledWith({ rung: "pro_200k" });
  });
  it("member cannot choose or change subscription", () => {
    h.role = "member";
    const tree = BillingView({ checkout: null, requestedRung: "pro_200k" });
    expect(
      nodes(tree).some((n) => n.type === "button" && n.props.className === "ms-btn ms-btn-primary"),
    ).toBe(false);
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it("missing intent keeps the current rung and comparison closed", () => {
    const tree = BillingView({ checkout: null });
    expect(nodes(tree).find((n) => n.props.id === "ms-volume")?.props.value).toBe(2);
    expect(nodes(tree).some((n) => n.props.open === true)).toBe(false);
  });
});
