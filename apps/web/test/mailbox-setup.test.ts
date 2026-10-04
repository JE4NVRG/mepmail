import { describe, expect, it } from "vitest";
import {
  mailboxSetupFailure,
  mailboxSetupLocalPart,
  mailboxSetupSeatState,
} from "../src/lib/mailbox-setup";

describe("mailbox setup admission feedback", () => {
  it("keeps a loaded full pilot blocked while preserving its existing boxes", () => {
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
