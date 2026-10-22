import { createTranslator } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enSettings from "../messages/en/settings.json";
import ptSettings from "../messages/pt-BR/settings.json";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  canonical: false,
  canManage: true,
  availability: "available",
  canPurchase: true,
  legacy: false,
  trialDays: 7,
  wrongTerms: false,
  mutate: vi.fn(),
  enabledQueries: [] as string[],
}));

// Canonical 9496 billing subset from checkout-disclosure-canonical.json.
// EN SHA256 67ec426ccd4c4894664cdba0176abd81b05b21b7f0cec8124c9ed0bbd46f454b
// PT SHA256 5dfd9bbc246fd039306d6e51398487eb15fb317e5647af35d17d24d61473d578
// Embedded so CI needs no local preserved artifacts; only disclosure is projected.
const CANONICAL_9496 = {
  en: {
    readOnly: "Only owners and admins can change billing.",
    perMonth: "/ month",
    launch: {
      perYear: "/ year",
    },
    combo: {
      step: "Step 2 of 2 \u00b7 Mail",
      title: "Finish your Mail inboxes",
      summary:
        "{seats, plural, one {# mailbox} other {# mailboxes}} of {size} \u00b7 {unit} each \u00b7 {total} {per}",
      confirming: "Confirming your Send payment\u2026 this usually takes a few seconds.",
      ready:
        "Your Send plan is active. Mail is a separate subscription: review it at Stripe and pay to activate your mailboxes.",
      pay: "Pay for Mail \u00b7 {total} {per}",
      retry: "Check again",
      timedOut:
        "We haven't confirmed your Send payment yet. Check again in a moment; your mailbox choice stays saved in this browser for 24 hours.",
      existing: "Your Mail subscription is already active.",
      manual: "Choose your inboxes on the Mail page to finish.",
      pending: "The Mail checkout is being prepared. Open the Mail page to continue it.",
      unavailable: "Mail purchases are unavailable right now. Please try again later.",
      openMailboxes: "Open Mail",
      skip: "Not now",
      close: "Close",
    },
  },
  "pt-BR": {
    readOnly: "Apenas propriet\u00e1rios e administradores podem alterar a cobran\u00e7a.",
    perMonth: "/ m\u00eas",
    launch: {
      perYear: "/ ano",
    },
    combo: {
      step: "Passo 2 de 2 \u00b7 Correio",
      title: "Conclua suas caixas do Correio",
      summary:
        "{seats, plural, one {# caixa} other {# caixas}} de {size} \u00b7 {unit} cada \u00b7 {total} {per}",
      confirming: "Confirmando o pagamento do Envio\u2026 isso costuma levar alguns segundos.",
      ready:
        "Seu plano de Envio est\u00e1 ativo. O Correio \u00e9 uma assinatura separada: revise na Stripe e pague para ativar suas caixas.",
      pay: "Pagar o Correio \u00b7 {total} {per}",
      retry: "Verificar de novo",
      timedOut:
        "Ainda n\u00e3o confirmamos o pagamento do Envio. Verifique de novo em instantes; sua escolha de caixas fica salva neste navegador por 24 horas.",
      existing: "Sua assinatura do Correio j\u00e1 est\u00e1 ativa.",
      manual: "Escolha suas caixas na p\u00e1gina do Correio para concluir.",
      pending:
        "O pagamento do Correio est\u00e1 em prepara\u00e7\u00e3o. Abra a p\u00e1gina do Correio para continuar.",
      unavailable:
        "A contrata\u00e7\u00e3o do Correio est\u00e1 indispon\u00edvel agora. Tente novamente mais tarde.",
      openMailboxes: "Abrir o Correio",
      skip: "Agora n\u00e3o",
      close: "Fechar",
    },
  },
} as const;

// These legacy cases exercise prices, maintenance and onboarding. Safety admission
// has its own denied/loading/approved coverage in purchase-review-ui.test.ts.
vi.mock("@/components/purchase-review-notice", async (original) => ({
  ...(await original<typeof import("@/components/purchase-review-notice")>()),
  usePurchaseReview: (enabled = true) => ({ enabled, allowed: true, refresh: vi.fn() }),
  PurchaseReviewNotice: () => null,
}));

vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useLocale: () => h.locale,
  useTranslations: () => {
    const source = h.locale === "pt-BR" ? ptSettings : enSettings;
    const canonical = CANONICAL_9496[h.locale];
    const settings = h.canonical
      ? {
          billing: {
            ...canonical,
            combo: { ...canonical.combo, disclosure: source.billing.combo.disclosure },
          },
        }
      : source;
    return createTranslator({
      locale: h.locale,
      messages: { settings },
      namespace: "settings.billing",
    });
  },
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("@/components/spinner", () => ({ BtnSpinner: () => null }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    mailboxes: {
      capabilities: { queryOptions: () => ({ fixture: "capabilities" }) },
      billing: { queryOptions: () => ({ fixture: "billing" }) },
      checkout: { mutationOptions: () => ({}) },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ fixture, enabled }: { fixture: string; enabled?: boolean }) => {
    if (enabled !== false) h.enabledQueries.push(fixture);
    const selected = {
      offerId: "synthetic-selected",
      currency: h.wrongTerms ? "eur" : "usd",
      unitAmount: 590,
      interval: "month",
      storageBytesPerMailbox: 1024 ** 3,
      includedOutboundPerMailbox: 750,
      quotaScope: h.legacy ? "mailbox" : "team",
      trialDays: h.trialDays,
      plan: h.legacy
        ? null
        : {
            code: "synthetic-plan",
            inboundDeliveriesPerPeriod: 2100,
            outboundBytesPerPeriod: 384 * 1024 ** 2,
            inboundBytesPerPeriod: 1.5 * 1024 ** 3,
          },
    };
    return {
      isPending: false,
      refetch: vi.fn(),
      data:
        fixture === "capabilities"
          ? { enabled: true }
          : {
              availability: h.availability,
              canPurchase: h.canPurchase,
              offers: [
                {
                  ...selected,
                  offerId: "synthetic-other",
                  unitAmount: 990,
                  storageBytesPerMailbox: 10 * 1024 ** 3,
                  includedOutboundPerMailbox: 999999,
                },
                selected,
              ],
            },
    };
  },
  useMutation: () => ({ mutateAsync: h.mutate, isPending: false }),
}));

import { LaunchComboMailStep } from "../src/app/(dashboard)/settings/billing/launch-combo-step";

function render() {
  return renderToStaticMarkup(
    createElement(LaunchComboMailStep, {
      intent: {
        v: 1,
        teamId: "synthetic-team",
        tier: "gib1",
        interval: "month",
        seats: 2,
        savedAt: 1,
      },
      canManage: h.canManage,
      onDone: vi.fn(),
    }),
  );
}

beforeEach(() => {
  h.locale = "en";
  h.canonical = false;
  h.canManage = true;
  h.availability = "available";
  h.canPurchase = true;
  h.legacy = false;
  h.trialDays = 7;
  h.wrongTerms = false;
  h.enabledQueries = [];
  h.mutate.mockClear();
});

describe("selected combo offer limits beside checkout", () => {
  it.each(["en", "pt-BR"] as const)(
    "renders canonical 9496 messages plus only combo.disclosure in %s without the queued discovery namespace",
    (locale) => {
      h.locale = locale;
      h.canonical = true;
      const canonical = CANONICAL_9496[locale];
      const source = locale === "pt-BR" ? ptSettings : enSettings;
      expect("discovery" in canonical).toBe(false);
      expect(Object.keys(source.billing.combo).filter((key) => !(key in canonical.combo))).toEqual([
        "disclosure",
      ]);
      const html = render();
      expect(html).toContain(source.billing.combo.disclosure.title);
      expect(html).toContain(locale === "pt-BR" ? "Entrada: 1,5 GiB" : "Inbound: 1.5 GiB");
      expect(html).toContain(locale === "pt-BR" ? "Pagar o Correio" : "Pay for Mail");
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );
  it("shows actual shared storage, recipients, message/byte allowances and eligible card trial in English", () => {
    const html = render();
    expect(html).toContain("Limits for the selected Mail offer");
    expect(html).toContain("Limits are shared across every mailbox in the plan");
    expect(html).toContain("1 GiB of storage");
    expect(html).toContain("750 outbound recipients per allowance period");
    expect(html).toContain("2,100 received messages per allowance period");
    expect(html).toContain("Outbound: 384 MiB per allowance period");
    expect(html).toContain("Inbound: 1.5 GiB per allowance period");
    expect(html).toContain("7 trial days with a card when eligible");
    expect(html).toContain("Pix does not include a free trial");
    expect(html).not.toContain("999,999");
    expect(html).not.toContain("2 GiB of storage");
    const id = html.match(/id="([^"]+-limits)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-describedby="${id}"`);
    expect(html.indexOf("Limits for the selected Mail offer")).toBeLessThan(
      html.indexOf("Pay for Mail"),
    );
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("uses the same catalog limits and localized quantities in Portuguese", () => {
    h.locale = "pt-BR";
    const html = render();
    expect(html).toContain("Limites da oferta do Correio selecionada");
    expect(html).toContain("Limites compartilhados entre todas as caixas");
    expect(html).toContain("2.100 mensagens recebidas por período de franquia");
    expect(html).toContain("Entrada: 1,5 GiB por período de franquia");
    expect(html).toContain("7 dias de teste com cartão quando elegível");
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("keeps legacy allowances per mailbox and invents no plan byte limits or trial", () => {
    h.legacy = true;
    h.trialDays = 0;
    const html = render();
    expect(html).toContain("Per-mailbox limits for this offer");
    expect(html).toContain("1 GiB of storage");
    expect(html).toContain("750 outbound recipients per allowance period");
    expect(html).not.toContain("received messages per allowance period");
    expect(html).not.toContain("Outbound:");
    expect(html).not.toContain("Inbound:");
    expect(html).not.toContain("trial days");
  });

  it("does not promote a trial when the server marks the team ineligible", () => {
    h.trialDays = 0;
    const html = render();
    expect(html).toContain("Outbound: 384 MiB");
    expect(html).not.toContain("trial days");
  });

  it("shows neither purchase nor disclosure for a nonmanager, blocked purchase or mismatched offer", () => {
    for (const change of [
      { canManage: false },
      { canPurchase: false },
      { availability: "sending_plan_required" },
      { wrongTerms: true },
    ]) {
      Object.assign(
        h,
        { canManage: true, canPurchase: true, availability: "available", wrongTerms: false },
        change,
      );
      const html = render();
      expect(html).not.toContain("Limits for the selected Mail offer");
      expect(html).not.toContain("Pay for Mail");
    }
    expect(h.mutate).not.toHaveBeenCalled();
  });
});
