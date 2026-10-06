import { describe, expect, it } from "vitest";
import {
  calculateLaunchQuote,
  describeLaunchPlan,
  getLaunchMailboxPlan,
  LAUNCH_OFFER,
  parseLaunchMailboxQuantity,
} from "../src/lib/launch-offer";

describe("approved launch quote", () => {
  it("applies the introduction only to a new monthly customer, retaining the recurring allowance", () => {
    const first = calculateLaunchQuote({ period: "month", isNewCustomer: true });
    const renewal = calculateLaunchQuote({ period: "month", isNewCustomer: false });
    expect(first.firstPaymentCents).toBe(2000);
    expect(first.recurringPeriodCents).toBe(2900);
    expect(first.introductorySavingCents).toBe(900);
    expect(renewal.firstPaymentCents).toBe(2900);
    expect(renewal.introductoryOfferApplied).toBe(false);
    expect(LAUNCH_OFFER.sending.monthlyRecipientDeliveries).toBe(110_000);
  });
  it("discounts only Send and leaves every mailbox at its regular monthly price", () => {
    const quote = calculateLaunchQuote({
      period: "month",
      mailboxTierId: "gib10",
      mailboxQuantity: 3,
      isNewCustomer: true,
    });
    expect(quote.mailboxUnitPeriodCents).toBe(990);
    expect(quote.mailboxTotalPeriodCents).toBe(2970);
    expect(quote.firstPaymentCents).toBe(4970);
    expect(quote.recurringPeriodCents).toBe(5870);
    expect(quote.mailbox?.monthlyRecipientDeliveries).toBe(2000);
  });
  it("charges ten normal monthly fees for twelve months, without stacking the introduction", () => {
    const first = calculateLaunchQuote({
      period: "year",
      mailboxTierId: "gib1",
      isNewCustomer: true,
    });
    const existing = calculateLaunchQuote({
      period: "year",
      mailboxTierId: "gib1",
      isNewCustomer: false,
    });
    expect(first).toEqual(existing);
    expect(first.sendingPeriodCents).toBe(29_000);
    expect(first.mailboxUnitPeriodCents).toBe(5900);
    expect(first.firstPaymentCents).toBe(34_900);
    expect(first.annualEquivalentMonthlyCents).toBe(2908);
    expect(first.introductoryOfferApplied).toBe(false);
    expect(first.annualSavingAgainstRegularMonthlyCents).toBe(6980);
  });
  it("keeps charge totals in integer cents through fifty mailboxes", () => {
    for (const mailbox of LAUNCH_OFFER.mailboxes) {
      for (const period of ["month", "year"] as const) {
        for (const mailboxQuantity of [1, 2, 50]) {
          const quote = calculateLaunchQuote({
            period,
            mailboxTierId: mailbox.id,
            mailboxQuantity,
            isNewCustomer: true,
          });
          expect(Number.isSafeInteger(quote.firstPaymentCents)).toBe(true);
          expect(Number.isSafeInteger(quote.recurringPeriodCents)).toBe(true);
          expect(quote.mailboxTotalPeriodCents).toBe(
            quote.mailboxUnitPeriodCents * mailboxQuantity,
          );
          expect(quote.firstPaymentCents).toBeGreaterThan(0);
        }
      }
    }
    expect(
      calculateLaunchQuote({
        period: "year",
        mailboxTierId: "gib10",
        mailboxQuantity: 50,
        isNewCustomer: true,
      }).firstPaymentCents,
    ).toBe(524_000);
  });
  it.each([0, 51, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    "rejects quantity %s instead of silently billing another quantity",
    (mailboxQuantity) => {
      expect(() =>
        calculateLaunchQuote({ period: "month", mailboxQuantity, isNewCustomer: true }),
      ).toThrow(RangeError);
    },
  );
  it.each(["", "0", "51", "1.5", "1e1", "-1", "NaN", " 1 "])(
    "rejects invalid input %j",
    (value) => {
      expect(parseLaunchMailboxQuantity(value)).toBeNull();
    },
  );
  it.each([1, 25, 50])("accepts valid quantity %s", (quantity) => {
    expect(parseLaunchMailboxQuantity(String(quantity))).toBe(quantity);
  });
});

describe("plan presentation preserves existing contracts", () => {
  it("uses recurring price for Mail qualification even in the introductory month", () => {
    expect(describeLaunchPlan({ kind: "launch" }).planQualifiesForMail).toBe(true);
    expect(describeLaunchPlan({ kind: "launch" }).recurringMonthlyCents).toBe(2900);
    expect(
      describeLaunchPlan({ kind: "legacy", recurringMonthlyCents: 2000 }).planQualifiesForMail,
    ).toBe(false);
    expect(
      describeLaunchPlan({ kind: "legacy", recurringMonthlyCents: 2000 }).recurringMonthlyCents,
    ).toBe(2000);
    expect(
      describeLaunchPlan({ kind: "legacy", recurringMonthlyCents: 10_000 }).planQualifiesForMail,
    ).toBe(true);
  });
  it("preserves System fifty GiB without commercial count or delivery allowances", () => {
    expect(describeLaunchPlan({ kind: "system" })).toEqual({
      planQualifiesForMail: true,
      commercialBillingExempt: true,
      recurringMonthlyCents: 0,
      internalMailbox: {
        storageGiB: 50,
        commercialMailboxCountLimit: null,
        commercialMonthlyRecipientLimit: null,
      },
    });
  });
  it("includes only the two approved mailbox tiers and monthly delivery allowances", () => {
    expect(LAUNCH_OFFER.mailboxes).toHaveLength(2);
    expect(getLaunchMailboxPlan("gib1")).toMatchObject({
      storageGiB: 1,
      monthlyCents: 590,
      monthlyRecipientDeliveries: 500,
    });
    expect(getLaunchMailboxPlan("gib10")).toMatchObject({
      storageGiB: 10,
      monthlyCents: 990,
      monthlyRecipientDeliveries: 2000,
    });
  });
});
