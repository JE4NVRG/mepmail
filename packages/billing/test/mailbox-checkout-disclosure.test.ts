import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  MAILBOX_TRIAL_DAILY_RECIPIENTS,
  MAILBOX_TRIAL_TOTAL_RECIPIENTS,
} from "../../core/src/mailbox-service.js";
import {
  createMailboxCheckoutSession,
  type MailboxCatalog,
  type MailboxPriceTerms,
} from "../src/mailbox.js";
import { mailboxCheckoutDisclosure } from "../src/mailbox-checkout-disclosure.js";
import { createPixCheckoutSession, type PixCheckoutInput, type PixStripe } from "../src/pix.js";
import type { BillingStripe } from "../src/stripe.js";

// Synthetic catalog only. No Stripe client, credentials, database or purchase.
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const plan: MailboxPriceTerms = {
  priceId: "price_mailbox_disclosure_fixture",
  currency: "brl",
  unitAmount: 1234,
  interval: "month",
  storageBytesPerMailbox: 10 * GiB,
  includedOutboundPerMailbox: 777,
  quotaScope: "team",
  includedMailboxes: 10,
  trialDays: 7,
  planCode: "equipe",
  inboundDeliveriesPerPeriod: 2222,
  inboundBytesPerPeriod: 3 * GiB,
  outboundBytesPerPeriod: 3 * GiB,
};
const legacy: MailboxPriceTerms = {
  priceId: "price_legacy_disclosure_fixture",
  currency: "usd",
  unitAmount: 321,
  interval: "year",
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 17,
};
const urls = {
  successUrl: "https://app.example.com/mailboxes?checkout=success",
  cancelUrl: "https://app.example.com/mailboxes",
};

function stripeFake() {
  const create = vi.fn(
    async (_params: Stripe.Checkout.SessionCreateParams, _options?: Stripe.RequestOptions) =>
      ({ url: "https://checkout.stripe.com/c/pay/cs_fixture" }) as Stripe.Checkout.Session,
  );
  const stripe = { checkout: { sessions: { create } } };
  return { create, card: stripe as unknown as BillingStripe, pix: stripe as unknown as PixStripe };
}

function firstCall(fake: ReturnType<typeof stripeFake>) {
  const call = fake.create.mock.calls[0];
  if (!call) throw new Error("Expected synthetic checkout call");
  return call;
}

function pixInput(): PixCheckoutInput {
  return {
    kind: "mailbox_start",
    teamId: "00000000-0000-4000-8000-000000000001",
    customerId: "cus_disclosure_fixture",
    amount: 1234,
    product: "prod_disclosure_fixture",
    priceId: plan.priceId,
    quantity: 1,
    mailbox: { terms: plan, seats: 10 },
    idempotencyKey: "pix-mailbox:disclosure-fixture",
    ...urls,
  };
}

function submit(params: Stripe.Checkout.SessionCreateParams): string {
  const text = params.custom_text?.submit;
  expect(text && typeof text !== "string").toBeTruthy();
  return (text as { message: string }).message;
}

describe("Hosted Correio checkout disclosure", () => {
  it.each([
    [256 * MiB, 512 * MiB, "256 MiB", "512 MiB"],
    [GiB, 1.5 * GiB, "1 GiB", "1.5 GiB"],
    [3 * GiB, 3 * GiB, "3 GiB", "3 GiB"],
  ])(
    "uses the selected catalog's byte allowances without rounding",
    (outbound, inbound, sent, received) => {
      const message = mailboxCheckoutDisclosure(
        { ...plan, outboundBytesPerPeriod: outbound, inboundBytesPerPeriod: inbound },
        10,
        { kind: "card", trialDays: 0 },
      );
      expect(message).toContain(`saída 777 destinatários / ${sent}`);
      expect(message).toContain(`entrada 2222 mensagens / ${received}`);
      expect(message).toContain(`outbound 777 recipients / ${sent}`);
      expect(message).toContain(`inbound 2222 messages / ${received}`);
    },
  );

  it("shows shared allowances once for ten mailboxes, with the receiving consequence", () => {
    const message = mailboxCheckoutDisclosure(plan, 10, { kind: "card", trialDays: 0 });
    expect(message).toContain(
      "10 caixa(s). Armazenamento: 10 GiB compartilhados pela equipe, não por caixa",
    );
    expect(message).toContain("Monthly allowances for the team");
    expect(message).toContain(
      "Mensagens que excedam o armazenamento ou a franquia de entrada podem ser recusadas.",
    );
    expect(message).toContain(
      "Incoming messages exceeding storage or inbound allowances may be rejected.",
    );
    expect(message).not.toMatch(/5\.1\.1|pausar|pause|retry/);
    expect(message).not.toContain("100 GiB");
    expect(message).not.toContain("7770");
  });

  it("preserves per-mailbox annual legacy terms without inventing inbound or byte caps", () => {
    const message = mailboxCheckoutDisclosure(legacy, 3, { kind: "card", trialDays: 0 });
    expect(message).toContain("3 caixa(s). Armazenamento: 4 KiB por caixa");
    expect(message).toContain("Franquias por período de uso por caixa: saída 17 destinatários.");
    expect(message).toContain("Allowances per usage period per mailbox: outbound 17 recipients.");
    expect(message).not.toMatch(/mensais|monthly|Monthly|billing year|per year|por ano/);
    expect(message).not.toMatch(/entrada|inbound|5\.1\.1|ilimitado|unlimited/);
    expect(message).not.toContain("12 KiB");
  });

  it("does not multiply a legacy shared bundle when extra seats are bought", () => {
    const message = mailboxCheckoutDisclosure(
      { ...legacy, quotaScope: "team", includedMailboxes: 3, extraUnitAmount: 100 },
      5,
      { kind: "card", trialDays: 0 },
    );
    expect(message).toContain("5 caixa(s). Armazenamento: 4 KiB compartilhados");
    expect(message).toContain("da equipe: saída 17 destinatários.");
  });

  it("only describes the applied card trial, including the enforced trial recipient caps", () => {
    const eligible = mailboxCheckoutDisclosure(plan, 10, { kind: "card", trialDays: 7 });
    expect(eligible).toContain("teste elegível de 7 dias");
    expect(eligible).toContain("50 destinatários/dia UTC, 200 no total");
    expect(eligible).toContain(
      `${MAILBOX_TRIAL_DAILY_RECIPIENTS} destinatários/dia UTC, ${MAILBOX_TRIAL_TOTAL_RECIPIENTS} no total`,
    );
    expect(eligible).toContain("eligible 7-day trial");
    for (const trialDays of [0]) {
      const ineligible = mailboxCheckoutDisclosure(plan, 10, { kind: "card", trialDays });
      expect(ineligible).toContain("sem teste grátis nesta compra");
      expect(ineligible).not.toContain("7-day");
      expect(ineligible).not.toContain("50 destinatários");
    }
  });

  it("can load the disclosure without importing DB/config server modules", async () => {
    vi.resetModules();
    vi.doMock("@millionsend/db", () => {
      throw new Error("The checkout disclosure must not load DB/config");
    });
    try {
      const isolated = await import("../src/mailbox-checkout-disclosure.js");
      expect(
        isolated.mailboxCheckoutDisclosure(plan, 10, { kind: "card", trialDays: 7 }),
      ).toContain("eligible 7-day trial");
    } finally {
      vi.doUnmock("@millionsend/db");
      vi.resetModules();
    }
  });

  it("makes Pix immediate and trial-free despite a catalog card trial", () => {
    const message = mailboxCheckoutDisclosure(plan, 10, { kind: "pix" });
    expect(message).toContain("Pix: sem teste grátis; primeiro mês pago agora");
    expect(message).toContain("Pix: no free trial; first month paid now");
    expect(message).not.toMatch(/7 dias|7-day|eligible|elegível/);
  });

  it("fits Stripe's submit-message limit even at the validated catalog maxima", () => {
    const message = mailboxCheckoutDisclosure(
      {
        ...plan,
        includedMailboxes: 10000,
        storageBytesPerMailbox: 10995116277760,
        includedOutboundPerMailbox: 1000000,
        inboundDeliveriesPerPeriod: 10000000,
        inboundBytesPerPeriod: 10995116277760,
        outboundBytesPerPeriod: 10995116277760,
      },
      10000,
      { kind: "card", trialDays: 30 },
    );
    expect(message.length).toBeLessThanOrEqual(1200);
    expect(message).toContain("10240 GiB");
  });

  it("attaches the message beside card confirmation and preserves quantity, trial and idempotency", async () => {
    const fake = stripeFake();
    const catalog: MailboxCatalog = {
      livemode: false,
      checkoutPriceId: plan.priceId,
      prices: [plan],
    };
    const input = {
      teamId: "team_disclosure_fixture",
      customerId: "cus_disclosure_fixture",
      seats: 10,
      trialDays: 7,
      idempotencyKey: "mailbox-checkout:stable-disclosure-fixture",
      ...urls,
    };
    await createMailboxCheckoutSession(fake.card, catalog, input);
    await createMailboxCheckoutSession(fake.card, catalog, input);
    const [params, options] = firstCall(fake);
    expect(submit(params)).toContain("10 caixa(s)");
    expect(submit(params)).toContain("teste elegível de 7 dias");
    expect(params.line_items).toEqual([{ price: plan.priceId, quantity: 1 }]);
    expect(params.subscription_data?.trial_period_days).toBe(7);
    expect(params.payment_method_collection).toBe("always");
    expect(params.cancel_url).toBe(urls.cancelUrl);
    expect(options).toEqual({ idempotencyKey: input.idempotencyKey });
    expect(fake.create.mock.calls[1]).toEqual(fake.create.mock.calls[0]);
  });

  it("does not infer a card trial from the catalog and keeps legacy Stripe quantity", async () => {
    const fake = stripeFake();
    const terms = { ...legacy, trialDays: 7 };
    await createMailboxCheckoutSession(
      fake.card,
      { livemode: false, checkoutPriceId: terms.priceId, prices: [terms] },
      {
        teamId: "team_disclosure_fixture",
        customerId: "cus_disclosure_fixture",
        seats: 3,
        idempotencyKey: "mailbox-checkout:legacy-disclosure-fixture",
        ...urls,
      },
    );
    const params = firstCall(fake)[0];
    expect(submit(params)).toContain("sem teste grátis nesta compra");
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
    expect(params.line_items).toEqual([{ price: terms.priceId, quantity: 3 }]);
  });

  it("attaches the resolved ten-mailbox plan to Pix without changing its payment parameters", async () => {
    const fake = stripeFake();
    const input = pixInput();
    await createPixCheckoutSession(fake.pix, input);
    const [params, options] = firstCall(fake);
    expect(submit(params)).toContain("10 caixa(s). Armazenamento: 10 GiB compartilhados");
    expect(submit(params)).toContain("Pix: no free trial");
    expect(params).toMatchObject({
      mode: "payment",
      payment_method_types: ["pix"],
      locale: "pt-BR",
    });
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: { currency: "brl", unit_amount: input.amount, product: input.product },
      },
    ]);
    expect(params).not.toHaveProperty("subscription_data");
    expect(params).not.toHaveProperty("mailbox");
    expect(options).toEqual({ idempotencyKey: input.idempotencyKey });
  });

  it.each(["missing", "price", "quantity", "seats", "invalid-terms"])(
    "rejects mismatched Pix disclosure context (%s) before Stripe",
    async (kind) => {
      const fake = stripeFake();
      const input = pixInput();
      const context = input.mailbox;
      if (!context) throw new Error("Missing synthetic mailbox context");
      if (kind === "missing") delete input.mailbox;
      if (kind === "price") input.priceId = "price_other_fixture";
      if (kind === "quantity") input.quantity = 10;
      if (kind === "seats") context.seats = 1;
      if (kind === "invalid-terms") context.terms = { ...plan, inboundBytesPerPeriod: undefined };
      await expect(createPixCheckoutSession(fake.pix, input)).rejects.toMatchObject({
        code: "invalid",
      });
      expect(fake.create).not.toHaveBeenCalled();
    },
  );

  it.each(["send_start", "invoice"] as const)(
    "keeps non-Correio Pix checkout (%s) unchanged",
    async (kind) => {
      const fake = stripeFake();
      const { mailbox: _mailbox, ...input } = pixInput();
      const request: PixCheckoutInput = { ...input, kind };
      if (kind === "invoice") {
        delete request.priceId;
        delete request.quantity;
        request.invoiceId = "in_disclosure_fixture";
      }
      await createPixCheckoutSession(fake.pix, request);
      expect(firstCall(fake)[0]).not.toHaveProperty("custom_text");
    },
  );
});
