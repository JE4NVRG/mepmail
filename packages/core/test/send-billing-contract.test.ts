import { describe, expect, it } from "vitest";
import {
  type SendBillingContract,
  verifiedSendBillingContract,
} from "../src/send-billing-contract.js";

const contract: SendBillingContract = {
  version: 1,
  teamId: "team_own",
  customerId: "cus_own",
  subscriptionId: "sub_own",
  baseItemId: "si_own",
  basePriceId: "price_archived",
  currency: "usd",
  baseAmountCents: 2_000,
  billingInterval: "month",
  intervalCount: 1,
  included: 110_000,
  usageInterval: "month",
  regularMonthlyCents: 2_000,
  financialPeriodStart: "2026-10-06T12:30:00.000Z",
  financialPeriodEnd: "2026-11-06T12:30:00.000Z",
  usageAnchor: "2026-10-06T12:30:00.000Z",
  verifiedAt: "2026-10-06T12:30:00.000Z",
};
const binding = {
  teamId: contract.teamId,
  customerId: contract.customerId,
  subscriptionId: contract.subscriptionId,
  financialPeriodStart: new Date(contract.financialPeriodStart),
  financialPeriodEnd: new Date(contract.financialPeriodEnd),
};

describe("verified Send contract binding", () => {
  it("keeps archived monthly amount and quota, without consulting the current catalog", () => {
    expect(verifiedSendBillingContract(contract, binding, binding.financialPeriodStart)).toEqual(
      contract,
    );
    expect(verifiedSendBillingContract({ ...contract, included: 100_001 }, binding)?.included).toBe(
      100_001,
    );
  });

  it.each([
    { teamId: "team_other" },
    { customerId: "cus_other" },
    { subscriptionId: "sub_other" },
    { customerId: null },
    { financialPeriodStart: new Date("2026-10-06T12:31:00Z") },
    { financialPeriodEnd: null },
  ])("rejects foreign or stale bindings: %j", (delta) => {
    expect(verifiedSendBillingContract(contract, { ...binding, ...delta })).toBeNull();
  });

  it.each([
    null,
    [],
    { ...contract, version: 2 },
    { ...contract, currency: "eur" },
    { ...contract, intervalCount: 2 },
    { ...contract, basePriceId: "untrusted" },
    { ...contract, included: 0 },
    { ...contract, included: 110_000.5 },
    { ...contract, baseAmountCents: 2_000, regularMonthlyCents: 2_900 },
    { ...contract, financialPeriodEnd: contract.financialPeriodStart },
    { ...contract, usageAnchor: "2026-10-01T00:00:00.000Z" },
    { ...contract, verifiedAt: "invalid" },
  ])("fails closed on malformed signed terms: %#", (value) => {
    expect(verifiedSendBillingContract(value, binding)).toBeNull();
  });

  it("uses an inclusive start and exclusive end when validating active access", () => {
    expect(
      verifiedSendBillingContract(
        contract,
        binding,
        new Date(binding.financialPeriodStart.getTime() - 1),
      ),
    ).toBeNull();
    expect(
      verifiedSendBillingContract(contract, binding, binding.financialPeriodStart),
    ).not.toBeNull();
    expect(
      verifiedSendBillingContract(
        contract,
        binding,
        new Date(binding.financialPeriodEnd.getTime() - 1),
      ),
    ).not.toBeNull();
    expect(verifiedSendBillingContract(contract, binding, binding.financialPeriodEnd)).toBeNull();
    expect(verifiedSendBillingContract(contract, binding, new Date(Number.NaN))).toBeNull();
  });

  it("accepts only the approved annual amount with a regular monthly base and monthly allowance", () => {
    const annual = {
      ...contract,
      billingInterval: "year",
      baseAmountCents: 29_000,
      regularMonthlyCents: 2_900,
      financialPeriodEnd: "2027-10-06T12:30:00.000Z",
    };
    const annualBinding = { ...binding, financialPeriodEnd: new Date(annual.financialPeriodEnd) };
    expect(verifiedSendBillingContract(annual, annualBinding)?.regularMonthlyCents).toBe(2_900);
    expect(
      verifiedSendBillingContract({ ...annual, included: 1_320_000 }, annualBinding),
    ).toBeNull();
    expect(
      verifiedSendBillingContract({ ...annual, regularMonthlyCents: 2_000 }, annualBinding),
    ).toBeNull();
    expect(
      verifiedSendBillingContract({ ...annual, usageInterval: "day" }, annualBinding),
    ).toBeNull();
  });
});
