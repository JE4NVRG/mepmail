import { describe, expect, it } from "vitest";
import {
  formatMailboxStorage,
  mailboxHasUnlimitedSeats,
  mailboxOfferSelection,
  mailboxSetupFailure,
  mailboxSetupLocalPart,
  mailboxSetupReceiving,
  mailboxSetupSeatState,
} from "../src/lib/mailbox-setup";

describe("mailbox plan selection", () => {
  const one = {
    offerId: "synthetic-one",
    currency: "usd",
    unitAmount: 1250,
    interval: "month" as const,
    storageBytesPerMailbox: 1024 ** 3,
    includedOutboundPerMailbox: 500,
  };
  const ten = {
    ...one,
    offerId: "synthetic-ten",
    unitAmount: 3750,
    storageBytesPerMailbox: 10 * 1024 ** 3,
    includedOutboundPerMailbox: 2000,
  };
  const catalog = { offer: one, offers: [one, ten], defaultOfferId: one.offerId };
  it("uses a currently available selection with its actual storage and allowance", () => {
    expect(mailboxOfferSelection(catalog, ten.offerId)).toMatchObject({
      offer: ten,
      offerId: ten.offerId,
      locked: false,
    });
  });
  it("replaces a removed choice with the current valid default rather than its old price", () => {
    const next = { ...one, unitAmount: 1550 };
    expect(
      mailboxOfferSelection(
        { offer: next, offers: [next], defaultOfferId: next.offerId },
        ten.offerId,
      ),
    ).toMatchObject({ offer: next, offerId: next.offerId });
  });
  it("resumes the server pending plan even when the selection and default are different", () => {
    expect(
      mailboxOfferSelection(
        { ...catalog, pendingOfferId: ten.offerId, pendingOffer: ten },
        one.offerId,
      ),
    ).toMatchObject({ offer: ten, offerId: ten.offerId, locked: true });
  });
  it("keeps valid pending terms available without creating a new catalog offer while purchases are paused", () => {
    expect(
      mailboxOfferSelection({
        offer: null,
        offers: [],
        defaultOfferId: null,
        pendingOfferId: ten.offerId,
        pendingOffer: ten,
      }),
    ).toMatchObject({ offers: [], offer: ten, offerId: ten.offerId, locked: true });
  });
  it.each([null, one])(
    "does not substitute a default for missing or mismatched pending terms: %j",
    (pendingOffer) => {
      expect(
        mailboxOfferSelection({ ...catalog, pendingOfferId: ten.offerId, pendingOffer }),
      ).toMatchObject({ offer: null, offerId: ten.offerId, locked: true });
    },
  );
  it("does not turn an unknown local checkout attempt into a different plan", () => {
    expect(mailboxOfferSelection(catalog, one.offerId, "synthetic-removed")).toMatchObject({
      offer: null,
      offerId: "synthetic-removed",
      locked: true,
    });
  });
  it("preserves the legacy default contract without fabricating a public offer ID", () => {
    const { offerId: _id, ...legacy } = one;
    expect(mailboxOfferSelection({ offer: legacy })).toMatchObject({
      offers: [],
      offer: legacy,
      offerId: null,
      locked: false,
    });
    expect(mailboxOfferSelection(undefined)).toMatchObject({ offer: null, offerId: null });
  });
});

describe("domain receiving feedback", () => {
  it("does not infer receiving from the absence of a domain check", () => {
    expect(mailboxSetupReceiving(undefined)).toEqual({ state: "unknown", mxHost: null });
  });
  it.each(["unknown", "needs_mx", "needs_activation", "ready", "paused"] as const)(
    "preserves the authoritative receiving state %s independently of sending verification",
    (state) => {
      expect(mailboxSetupReceiving({ state, mxHost: "inbound.synthetic.invalid" })).toEqual({
        state,
        mxHost: "inbound.synthetic.invalid",
      });
    },
  );
  it("keeps an unsupported receiving region from fabricating an MX destination", () => {
    expect(mailboxSetupReceiving({ state: "unknown", mxHost: null })).toEqual({
      state: "unknown",
      mxHost: null,
    });
  });
  it("formats actual storage allowances without converting them into unlimited resources", () => {
    expect(formatMailboxStorage(1024 ** 3, "en")).toBe("1 GiB");
    expect(formatMailboxStorage(1536, "pt-BR")).toBe("1,5 KiB");
    expect(formatMailboxStorage(0, "en")).toBe("0 B");
  });
});

describe("mailbox setup admission feedback", () => {
  it("keeps a loaded full finite license blocked while preserving its existing boxes", () => {
    expect(mailboxSetupSeatState({ active: true, seats: 2, reservedSeats: 2 }, false, false)).toBe(
      "full",
    );
  });
  it("does not offer a seat from stale data after a failed refresh", () => {
    expect(mailboxSetupSeatState({ active: true, seats: 2, reservedSeats: 1 }, false, true)).toBe(
      "error",
    );
  });
  it("waits for the actual subscription state", () => {
    expect(mailboxSetupSeatState(undefined, true, false)).toBe("loading");
  });
  it("rejects an expired or inactive license even with unused seats", () => {
    expect(mailboxSetupSeatState({ active: false, seats: 2, reservedSeats: 1 }, false, false)).toBe(
      "inactive",
    );
  });
  it("allows an active available seat and catches over-reservation", () => {
    expect(mailboxSetupSeatState({ active: true, seats: 2, reservedSeats: 1 }, false, false)).toBe(
      "ready",
    );
    expect(mailboxSetupSeatState({ active: true, seats: 2, reservedSeats: 3 }, false, false)).toBe(
      "full",
    );
  });
  it("does not treat an active zero-seat DTO as admission", () => {
    expect(mailboxSetupSeatState({ active: true, seats: 0, reservedSeats: 0 }, false, false)).toBe(
      "inactive",
    );
  });
  it("admits an authoritative active System license beyond its legacy seat count", () => {
    const plan = {
      active: true,
      licenseKind: "system" as const,
      unlimitedSeats: true,
      seats: 2,
      reservedSeats: 3,
    };
    expect(mailboxHasUnlimitedSeats(plan)).toBe(true);
    expect(mailboxSetupSeatState(plan, false, false)).toBe("ready");
    expect(mailboxSetupSeatState({ ...plan, seats: 0 }, false, false)).toBe("ready");
  });
  it("keeps stale, loading and inactive System data from admitting another mailbox", () => {
    const plan = {
      active: true,
      licenseKind: "system" as const,
      unlimitedSeats: true,
      seats: 2,
      reservedSeats: 2,
    };
    expect(mailboxSetupSeatState(plan, false, true)).toBe("error");
    expect(mailboxSetupSeatState(plan, true, false)).toBe("loading");
    expect(mailboxSetupSeatState({ ...plan, active: false }, false, false)).toBe("inactive");
    expect(mailboxHasUnlimitedSeats({ ...plan, active: false })).toBe(false);
  });
  it.each([
    { licenseKind: "subscription" as const, unlimitedSeats: true },
    { licenseKind: "none" as const, unlimitedSeats: true },
    { licenseKind: "system" as const, unlimitedSeats: false },
    { licenseKind: "system" as const },
    { unlimitedSeats: true },
    {},
  ])("preserves finite admission when license flags are missing or inconsistent: %j", (flags) => {
    const plan = { active: true, seats: 2, reservedSeats: 2, ...flags };
    expect(mailboxHasUnlimitedSeats(plan)).toBe(false);
    expect(mailboxSetupSeatState(plan, false, false)).toBe("full");
  });
});

describe("new address feedback", () => {
  it("normalizes an address that does not already exist", () => {
    expect(mailboxSetupLocalPart(" Luna ")).toBe("luna");
    expect(mailboxSetupLocalPart("agency-agent_2")).toBe("agency-agent_2");
  });
  it.each([
    "",
    "luna@example.com",
    "*",
    "luna..agent",
    ".luna",
    "luna.",
    "luna-",
    "área",
    "a".repeat(65),
  ])("keeps invalid local part %s out of a valid preview", (local) => {
    expect(mailboxSetupLocalPart(local)).toBeNull();
  });
  it("keeps labels and raw provider errors out of public feedback", () => {
    expect(mailboxSetupFailure({ data: { code: "PRECONDITION_FAILED" }, message: "quota" })).toBe(
      "quota",
    );
    expect(
      mailboxSetupFailure({ data: { code: "PRECONDITION_FAILED" }, message: "not_entitled" }),
    ).toBe("notEntitled");
    expect(mailboxSetupFailure({ data: { code: "CONFLICT" } })).toBe("conflict");
    expect(mailboxSetupFailure({ data: { code: "BAD_REQUEST" } })).toBe("invalid");
    expect(mailboxSetupFailure(new Error("private synthetic error"))).toBe("error");
  });
});
