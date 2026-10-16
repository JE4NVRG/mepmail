import { createTranslator } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enSettings from "../messages/en/settings.json";
import ptSettings from "../messages/pt-BR/settings.json";

const h = vi.hoisted(() => ({
  locale: "pt-BR" as "en" | "pt-BR",
  android: false,
  role: "owner",
  subscribed: false,
  interval: "month" as "month" | "year",
  currentMail: null as "solo" | null,
  capability: { enabled: true, offered: false },
  mutation: vi.fn(),
  activeQueries: [] as string[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => {
    const set = vi.fn();
    h.setters.push(set);
    return [value, set];
  },
  useEffect: () => undefined,
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useLocale: () => h.locale,
  useTranslations: (namespace: "settings.billing" | "settings.plans" | "settings.usage") =>
    createTranslator({
      locale: h.locale,
      messages: { settings: h.locale === "pt-BR" ? ptSettings : enSettings },
      namespace,
    }),
}));
vi.mock("@/lib/use-android-app", () => ({ useInAndroidApp: () => h.android }));
vi.mock("@/lib/trpc", () => {
  const operation = (kind: string) => ({
    queryOptions: (_input?: unknown, options = {}) => ({ kind, ...options }),
    queryFilter: () => ({}),
    mutationOptions: () => ({}),
  });
  return {
    useTRPC: () => ({
      billing: Object.fromEntries(
        [
          "status",
          "checkout",
          "pixCheckout",
          "portal",
          "changePlan",
          "setOverage",
          "cancelRenewal",
        ].map((key) => [key, operation(`billing.${key}`)]),
      ),
      team: { list: operation("team.list") },
      settings: { usage: { recent: operation("usage") } },
      mailboxes: {
        capabilities: operation("mailboxes.capabilities"),
        billing: operation("mailboxes.billing"),
      },
    }),
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ kind, enabled }: { kind: string; enabled?: boolean }) => {
    if (enabled !== false) h.activeQueries.push(kind);
    const offers = [
      {
        offerId: "solo",
        plan: { code: "solo" },
        unitAmount: 290,
        currency: "usd",
        interval: "month",
        includedMailboxes: 1,
        localCurrency: { currency: "brl", unitAmount: 1490 },
      },
      {
        offerId: "duo",
        plan: { code: "duo" },
        unitAmount: 590,
        currency: "usd",
        interval: "month",
        includedMailboxes: 3,
        localCurrency: { currency: "brl", unitAmount: 2990 },
      },
      {
        offerId: "equipe",
        plan: { code: "equipe" },
        unitAmount: 1290,
        currency: "usd",
        interval: "month",
        includedMailboxes: 10,
        localCurrency: { currency: "brl", unitAmount: 6490 },
      },
    ].map((offer, index) => ({
      ...offer,
      quotaScope: "team",
      storageBytesPerMailbox: ([1, 3, 10][index] ?? 0) * 1024 ** 3,
      includedOutboundPerMailbox: [500, 2000, 6000][index],
      trialDays: 7,
      plan: {
        ...offer.plan,
        inboundDeliveriesPerPeriod: [2000, 5000, 10000][index],
        outboundBytesPerPeriod: [256 * 1024 ** 2, 1024 ** 3, 3 * 1024 ** 3][index],
        inboundBytesPerPeriod: [512 * 1024 ** 2, 1.5 * 1024 ** 3, 3 * 1024 ** 3][index],
      },
    }));
    const data =
      kind === "team.list"
        ? { activeTeamId: "synthetic", teams: [{ teamId: "synthetic", role: h.role }] }
        : kind === "mailboxes.capabilities"
          ? h.capability
          : kind === "mailboxes.billing"
            ? {
                offers,
                availability: h.currentMail ? "existing_subscription" : "available",
                management: { currentPlan: h.currentMail },
              }
            : {
                plan: h.subscribed ? "pro" : "free",
                rung: h.subscribed ? "pro_100k" : "free",
                planQuota: h.subscribed ? 110000 : null,
                pendingRung: null,
                planStatus: h.subscribed ? "active" : "none",
                currentPeriodEnd: new Date("2027-01-01"),
                cancelAt: null,
                quota: h.subscribed
                  ? {
                      kind: "month",
                      included: 110000,
                      periodEnd: new Date("2027-01-01"),
                      overage: false,
                      overageCentsPer1k: 35,
                    }
                  : { kind: "day", limit: 100 },
                usage: { accepted: 0 },
                hasCustomer: h.subscribed,
                hasLiveSubscription: h.subscribed,
                billingInterval: h.interval,
                subscriptionState: h.subscribed ? "confirmed" : "none",
                effectiveRung: h.subscribed
                  ? { priceCents: h.interval === "year" ? 29000 : 2900 }
                  : null,
                launchOffer: {
                  rung: "pro_100k",
                  monthlyCents: 2900,
                  firstMonthlyCents: 2000,
                  annualCents: 29000,
                  monthlyRecipientDeliveries: 110000,
                },
                newSubscriptionsPaused: false,
                pixAvailable: false,
                paidByPix: false,
              };
    return { data, isError: false, isPending: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: h.mutation, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/modal", () => ({ Modal: () => null }));
vi.mock("@/components/odometer", () => ({
  Odometer: ({ formatted }: { formatted: string }) => formatted,
}));
vi.mock("../src/app/(dashboard)/settings/usage/usage-view", () => ({ QuotaRow: () => null }));
vi.mock("../src/app/(dashboard)/settings/billing/pix-invoices", () => ({
  PixInvoices: () => null,
}));
vi.mock("../src/app/(dashboard)/settings/billing/launch-combo-step", () => ({
  LaunchComboMailStep: () => null,
}));
const { BillingView } = await import("../src/app/(dashboard)/settings/billing/billing-view");
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function render() {
  const tree = BillingView({ checkout: null });
  return { tree, html: renderToStaticMarkup(tree).replace(/\u00a0/g, " ") };
}
beforeEach(() => {
  h.locale = "pt-BR";
  h.android = false;
  h.role = "owner";
  h.subscribed = false;
  h.interval = "month";
  h.currentMail = null;
  h.capability = { enabled: true, offered: false };
  h.mutation.mockReset();
  h.activeQueries = [];
  h.setters = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("synthetic billing plan discovery, with no purchase or customer data", () => {
  it.each(["pt-BR", "en"] as const)(
    "shows Starter and all sending rungs before the Pro promotion in %s",
    (locale) => {
      h.locale = locale;
      const { tree, html } = render();
      expect(html.includes("Starter")).toBe(true);
      expect(html.includes(locale === "pt-BR" ? "R$ 49,00" : "$9")).toBe(true);
      expect(html.includes(locale === "pt-BR" ? "45.000" : "45,000")).toBe(true);
      expect(html.includes(locale === "pt-BR" ? "30 dias" : "30 days")).toBe(true);
      expect(html.indexOf("Starter")).toBeLessThan(
        html.indexOf((locale === "pt-BR" ? ptSettings : enSettings).billing.launch.title),
      );
      const detailButtons = nodes(tree).filter(
        (node) =>
          node.type === "button" &&
          typeof node.props["aria-label"] === "string" &&
          String(node.props["aria-label"]).includes("Starter"),
      );
      expect(detailButtons).toHaveLength(1);
      const starter = detailButtons[0];
      if (!starter) throw new Error("Missing Starter details control");
      (starter.props.onClick as () => void)();
      expect(h.setters[0]).toHaveBeenCalledWith(1);
      expect(h.setters.some((set) => set.mock.calls.some(([value]) => value === true))).toBe(true);
      expect(h.mutation).not.toHaveBeenCalled();
    },
  );
  it("shows Mail prices and a labeled, same-currency Free plus Solo catalog example", () => {
    const { html } = render();
    expect(html.includes("R$ 14,90")).toBe(true);
    expect(html.includes("Exemplo mensal de catálogo")).toBe(true);
    expect(html.includes("= R$ 14,90 / mês")).toBe(true);
    expect(html.includes("não confirmam a moeda")).toBe(true);
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("renders the offer's shared quotas, byte limits and eligible card trial next to its price", () => {
    const { html } = render();
    expect(html.includes("Limites compartilhados entre todas as caixas")).toBe(true);
    expect(html.includes("1 GiB de armazenamento")).toBe(true);
    expect(html.includes("Saída: 256 MiB")).toBe(true);
    expect(html.includes("Entrada: 1,5 GiB")).toBe(true);
    expect(html.includes("7 dias de teste com cartão")).toBe(true);
    expect(html.includes("Pix não inclui teste grátis")).toBe(true);
  });
  it("keeps an annual active Send contract and an identified Mail subscription separate", () => {
    h.subscribed = true;
    h.interval = "year";
    h.currentMail = "solo";
    const { html } = render();
    expect(html.includes("Plano do Correio identificado: Solo")).toBe(true);
    expect(html.includes("Exemplo mensal de catálogo")).toBe(false);
    expect(html.includes("anuais antecipados")).toBe(true);
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("lets a member inspect Starter without offering a purchase", () => {
    h.role = "member";
    const { html } = render();
    expect(html.includes("Starter")).toBe(true);
    expect(html.includes(ptSettings.billing.readOnly)).toBe(true);
    expect(html.includes(ptSettings.billing.launch.continue)).toBe(false);
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("does not query protected Mail billing for an offer without registry capability", () => {
    h.capability = { enabled: false, offered: true };
    const { html } = render();
    expect(h.activeQueries.includes("mailboxes.billing")).toBe(false);
    expect(html.includes("R$ 14,90")).toBe(true);
  });
  it("preserves Android status and cancellation while excluding prices, plan discovery and Mail queries", () => {
    h.android = true;
    h.subscribed = true;
    const { html } = render();
    expect(html.includes("R$") || html.includes("US$") || html.includes("Starter")).toBe(false);
    expect(html.includes(ptSettings.billing.app.cancelRenewal)).toBe(true);
    expect(h.activeQueries.some((query) => query.startsWith("mailboxes."))).toBe(false);
    expect(h.mutation).not.toHaveBeenCalled();
  });
  it("disables Mail queries immediately for the Android document before the React mode effect", () => {
    vi.stubGlobal("document", {
      documentElement: { hasAttribute: (name: string) => name === "data-android-app" },
    });
    const { html } = render();
    expect(h.activeQueries.some((query) => query.startsWith("mailboxes."))).toBe(false);
    expect((html.match(/data-purchase=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
