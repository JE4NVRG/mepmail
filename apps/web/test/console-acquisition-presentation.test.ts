import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  MailSubscriptionCell,
  OwnerSignupCell,
  SubscriptionStatus,
} from "@/components/console/teams/cells";
import enConsole from "../messages/en/console.json";
import enSettings from "../messages/en/settings.json";
import ptConsole from "../messages/pt-BR/console.json";
import ptSettings from "../messages/pt-BR/settings.json";

function render(locale: "en" | "pt-BR", child: ReactElement) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages:
        locale === "en"
          ? { console: enConsole, settings: enSettings }
          : { console: ptConsole, settings: ptSettings },
      // biome-ignore lint/correctness/noChildrenProp: provider requires children in its props type.
      children: child,
    }),
  );
}

it.each(["en", "pt-BR"] as const)(
  "labels missing signup and disabled Mail as unmeasured in %s",
  (locale) => {
    const text = locale === "en" ? "Not measured" : "Não medido";
    expect(render(locale, createElement(OwnerSignupCell, { attribution: null }))).toContain(text);
    expect(
      render(locale, createElement(MailSubscriptionCell, { subscription: null, enabled: false })),
    ).toContain(text);
    expect(render(locale, createElement(MailSubscriptionCell, { subscription: null }))).toContain(
      locale === "en" ? "No Correio subscription" : "Sem contrato de Correio",
    );
  },
);

it("shows only the supplied owner's measurement, escaping values and preserving the pre-login landing", () => {
  const html = render(
    "pt-BR",
    createElement(OwnerSignupCell, {
      detailed: true,
      attribution: {
        source: "<source>",
        medium: "post",
        campaign: "campaign",
        content: "creative",
        term: "term",
        referrer: "news.example",
        landingPath: "/migrate",
      },
    }),
  );
  expect(html).toContain("&lt;source&gt;");
  for (const value of [
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "news.example",
    "/migrate",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("<source>");
  expect(html).not.toContain("/login");
});

it.each(["en", "pt-BR"] as const)(
  "shows Mail plan, localized state, cancellation and a period rather than a promised trial end in %s",
  (locale) => {
    const html = render(
      locale,
      createElement(MailSubscriptionCell, {
        detailed: true,
        subscription: {
          planCode: "solo",
          status: "trialing",
          periodEnd: "2026-11-01T00:00:00Z",
          cancelAtPeriodEnd: true,
        },
      }),
    );
    expect(html).toContain("solo");
    expect(html).toContain(
      locale === "en" ? enSettings.billing.status.trialing : ptSettings.billing.status.trialing,
    );
    expect(html).toContain(locale === "en" ? "Period ends on" : "Período termina em");
    expect(html).toContain(locale === "en" ? "Cancels at the end" : "Cancelamento ao fim");
  },
);

it.each(["active", "past_due", "canceled", "unpaid", "incomplete", "none"] as const)(
  "reuses the existing billing label for Stripe state %s",
  (status) => {
    expect(render("pt-BR", createElement(SubscriptionStatus, { status }))).toContain(
      ptSettings.billing.status[status],
    );
  },
);

it("does not invent a plan name for a legacy Mail row or a diagnosis for an unknown provider state", () => {
  expect(
    render(
      "pt-BR",
      createElement(MailSubscriptionCell, {
        subscription: {
          planCode: null,
          status: "inactive",
          periodEnd: "2026-11-01T00:00:00Z",
          cancelAtPeriodEnd: false,
        },
      }),
    ),
  ).toContain("Contrato legado");
  expect(render("en", createElement(SubscriptionStatus, { status: "provider_unknown" }))).toContain(
    "provider_unknown",
  );
});
