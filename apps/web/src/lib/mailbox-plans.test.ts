import { describe, expect, it } from "vitest";
import {
  defaultMailboxPlanOffer,
  formatMailboxBytes,
  isMailboxPlanCode,
  mailboxMeterLevel,
  mailboxPlanDirection,
  mailboxPlanOffers,
} from "./mailbox-plans";

const allowance = (code: string) => ({
  code,
  inboundDeliveriesPerPeriod: 1,
  inboundBytesPerPeriod: 1,
  outboundBytesPerPeriod: 1,
});
const offer = (offerId: string, code: string | null, unitAmount: number, mailboxes: number) => ({
  offerId,
  unitAmount,
  includedMailboxes: mailboxes,
  plan: code ? allowance(code) : null,
});

describe("mailbox plans", () => {
  const legacy = offer("legacy", null, 1290, 3);
  const solo = offer("solo", "solo", 290, 1);
  const duo = offer("duo", "duo", 590, 3);
  const equipe = offer("equipe", "equipe", 1290, 10);

  it("keeps only plan offers, smallest first, and ignores unknown codes", () => {
    const plans = mailboxPlanOffers([equipe, legacy, solo, offer("x", "enterprise", 1, 1), duo]);
    expect(plans.map((p) => p.offerId)).toEqual(["solo", "duo", "equipe"]);
    expect(isMailboxPlanCode("duo")).toBe(true);
    expect(isMailboxPlanCode("enterprise")).toBe(false);
  });

  it("starts a purchase on the catalog default when it is a plan, else on Duo", () => {
    const plans = mailboxPlanOffers([solo, duo, equipe]);
    expect(defaultMailboxPlanOffer(plans, "equipe")?.offerId).toBe("equipe");
    expect(defaultMailboxPlanOffer(plans, "legacy")?.offerId).toBe("duo");
    expect(defaultMailboxPlanOffer(mailboxPlanOffers([solo, equipe]), null)?.offerId).toBe("solo");
    expect(defaultMailboxPlanOffer([], null)).toBeNull();
  });

  it("calls more mailboxes or a higher price an upgrade, like the server", () => {
    expect(mailboxPlanDirection(solo, 1, duo)).toBe("upgrade");
    expect(mailboxPlanDirection(equipe, 10, duo)).toBe("downgrade");
    expect(mailboxPlanDirection(duo, 3, solo)).toBe("downgrade");
    // An older 3-mailbox contract: Equipe has more mailboxes, Duo the same.
    expect(mailboxPlanDirection(null, 3, equipe)).toBe("upgrade");
    expect(mailboxPlanDirection(null, 3, duo)).toBe("downgrade");
  });

  it("reads a meter as near from 80 %, full at the limit and paused past pauseAt", () => {
    expect(mailboxMeterLevel(10, 100)).toBe("ok");
    expect(mailboxMeterLevel(80, 100)).toBe("near");
    expect(mailboxMeterLevel(100, 100)).toBe("full");
    expect(mailboxMeterLevel(105, 100, 110)).toBe("full");
    expect(mailboxMeterLevel(110, 100, 110)).toBe("paused");
    expect(mailboxMeterLevel(5, null)).toBe("ok");
    expect(mailboxMeterLevel(5, 0)).toBe("ok");
  });

  it("formats bytes in binary units with one decimal", () => {
    expect(formatMailboxBytes(3 * 1024 ** 3, "en")).toBe("3 GiB");
    expect(formatMailboxBytes(1.5 * 1024 ** 3, "pt-BR")).toBe("1,5 GiB");
    expect(formatMailboxBytes(256 * 1024 ** 2, "en")).toBe("256 MiB");
    expect(formatMailboxBytes(512, "en")).toBe("512 B");
  });
});
