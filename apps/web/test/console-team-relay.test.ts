import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TeamDialog } from "@/components/console/teams/team-dialog";
import type { TeamDetail } from "@/components/console/teams/types";
import enCommon from "../messages/en/common.json";
import enConsole from "../messages/en/console.json";
import enDomains from "../messages/en/domains.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptConsole from "../messages/pt-BR/console.json";
import ptDomains from "../messages/pt-BR/domains.json";

// The modal portals into document.body; inline, the dialog's body renders on the server.
vi.mock("@/components/modal", () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "data-title": title }, children),
}));

const BASE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Shop",
  plan: "pro",
  planQuota: 110_000,
  members: [{ email: "owner@shop.dev", name: "Owner", role: "owner" }],
  domains: 2,
  contacts: 10,
  sent30d: 100,
  scoreTenths: 90,
  region: "us-east-1",
  guardrail: "ok",
  suspendedAt: null,
  broadcastsPausedByOperatorAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  stripeSubscriptionId: null,
  stripeSubscriptionUrl: null,
  planStatus: "none",
  dailySendCeiling: null,
  standingAt: null,
  supportView: null,
  supportViewEnabled: false,
};

const RELAY = {
  name: "azure",
  domains: [
    {
      id: "00000000-0000-4000-8000-0000000000d1",
      name: "on.shop.dev",
      region: "us-east-1",
      status: "verified",
      relayEnabledAt: new Date("2026-10-07T20:00:00Z"),
    },
    {
      id: "00000000-0000-4000-8000-0000000000d2",
      name: "off.shop.dev",
      region: "us-east-1",
      status: "verified",
      relayEnabledAt: null,
    },
    {
      id: "00000000-0000-4000-8000-0000000000d3",
      name: "pending.shop.dev",
      region: "us-east-1",
      status: "pending",
      relayEnabledAt: null,
    },
  ],
};

function render(
  locale: "en" | "pt-BR",
  relay: typeof RELAY | null,
  relayPending: string | null = null,
): string {
  const [common, consoleMessages, domains] =
    locale === "en" ? [enCommon, enConsole, enDomains] : [ptCommon, ptConsole, ptDomains];
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { common, console: consoleMessages, domains },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(TeamDialog, {
        name: "Shop",
        detail: { ...BASE, relay } as unknown as TeamDetail,
        relayPending,
        onClose: () => {},
        onAdjustLimits: () => {},
        onViewAsOwner: () => {},
        onSetRelay: () => {},
      }),
    }),
  );
}

/** The relay row's <dd> for one domain. */
function row(html: string, domain: string): string {
  const at = html.indexOf(`<dt>${domain}</dt>`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</dd>", at));
}

describe("TeamDialog relay switches", () => {
  it("shows nothing of the relay while CUSTOMER_SMTP_RELAY_URL is unset", () => {
    const html = render("en", null);
    expect(html).not.toContain("SMTP relay");
    expect(html).not.toContain("Turn on");
  });

  it("lists each domain with its switch, a domain MepMail has not verified locked off", () => {
    const html = render("en", RELAY);
    expect(html).toContain("SMTP relay · azure");
    expect(row(html, "on.shop.dev")).toContain("on since");
    expect(row(html, "on.shop.dev")).toContain("Turn off");
    expect(row(html, "off.shop.dev")).toMatch(/<button[^>]*>.*Turn on/);
    expect(row(html, "off.shop.dev")).not.toMatch(/<button[^>]*disabled/);
    expect(row(html, "pending.shop.dev")).toContain("not verified");
    expect(row(html, "pending.shop.dev")).toMatch(/<button[^>]*disabled/);
  });

  it("locks every switch while one is being saved", () => {
    const html = render("en", RELAY, RELAY.domains[1]?.id ?? null);
    for (const domain of RELAY.domains)
      expect(row(html, domain.name)).toMatch(/<button[^>]*disabled/);
  });

  it("speaks Portuguese", () => {
    const html = render("pt-BR", RELAY);
    expect(html).toContain("Relay SMTP · azure");
    expect(row(html, "on.shop.dev")).toContain("Desligar");
    expect(row(html, "off.shop.dev")).toContain("Ligar");
    expect(row(html, "pending.shop.dev")).toContain("não verificado");
  });
});
