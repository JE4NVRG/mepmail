import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CORREIO_FROM_CENTS, LAUNCH_OFFER } from "@/lib/launch-offer";

// The approved Correio plans (atlas-pricing-plan-contract.json, Jean 2026-10-10). The
// public pages read LAUNCH_OFFER.correioPlans; the billing catalog sells the same terms.
const CONTRACT = [
  { id: "solo", usd: 290, brl: 1490, mailboxes: 1, gib: 1, out: 500, inbound: 2000 },
  { id: "duo", usd: 590, brl: 2990, mailboxes: 3, gib: 3, out: 2000, inbound: 5000 },
  { id: "equipe", usd: 1290, brl: 6490, mailboxes: 10, gib: 10, out: 6000, inbound: 10000 },
];
const messages = (locale: string, name: string) =>
  JSON.parse(
    readFileSync(new URL(`../messages/${locale}/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, Record<string, unknown>>;

describe("Correio plans on the public pages", () => {
  it("present exactly the approved plans, smallest first", () => {
    expect(
      LAUNCH_OFFER.correioPlans.map((plan) => ({
        id: plan.id,
        usd: plan.monthlyCents,
        brl: plan.brlMonthlyCents,
        mailboxes: plan.mailboxes,
        gib: plan.storageGiB,
        out: plan.monthlyRecipientDeliveries,
        inbound: plan.monthlyInboundMessages,
      })),
    ).toEqual(CONTRACT);
    expect(CORREIO_FROM_CENTS).toBe(290);
    expect(LAUNCH_OFFER.correioTrialDays).toBe(7);
  });

  it("name every plan and keep the retired 3-mailbox bundle prices out of the copy", () => {
    for (const locale of ["en", "pt-BR"]) {
      const pricing = messages(locale, "pricing").correio as { names: Record<string, string> };
      for (const plan of CONTRACT) expect(pricing.names[plan.id]).toBeTruthy();
      for (const name of ["pricing", "correio", "landing", "support"]) {
        const text = JSON.stringify(messages(locale, name));
        // US$ 3.90 per extra mailbox and R$ 19.90 belonged to the bundle the plans replace.
        expect(text).not.toMatch(/US\$ 3[.,]90|R\$ 19[.,]90/);
        expect(text).not.toMatch(/US\$ 12[.,]90 (a month|por mês) (with|com) 3/);
      }
    }
  });
});
