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
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
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
          effectiveRung: { key: "pro_100k", priceCents: 2900 },
          plan: "pro",
          planQuota: 110000,
          rung: "pro_100k",
          pendingRung: null,
          planStatus: "active",
          currentPeriodEnd: null,
          quota: {
            kind: "month",
            included: 110000,
            periodEnd: new Date("2026-10-01"),
            overage: true,
            overageCentsPer1k: h.rate,
          },
          usage: { accepted: 111001 },
          hasCustomer: true,
          hasLiveSubscription: true,
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
});

describe("billing selection synthetic UI contract, not paid E2E", () => {
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
          formatUsd(2900, locale),
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
