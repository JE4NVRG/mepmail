import { expect, it } from "vitest";
import { mailboxDeliveryBadge, mailboxDeliveryLabel } from "../src/lib/mailbox-delivery-status";

const empty = {
  totalRecipients: 1,
  delivered: 0,
  delayed: 0,
  hardBounce: 0,
  complaint: 0,
  softBounce: 0,
  rejected: 0,
  renderingFailed: 0,
  unconfirmed: 1,
};
it("keeps queued distinct from acceptance", () =>
  expect(mailboxDeliveryBadge("queued", empty)).toBe("deliveryStatus.queued"));
it("does not call SMTP acceptance delivered", () =>
  expect(mailboxDeliveryBadge("accepted", empty)).toBe("deliveryStatus.accepted"));
it("prioritizes authenticated recipient delivery over accepted outbox state", () =>
  expect(mailboxDeliveryBadge("accepted", { ...empty, delivered: 1, unconfirmed: 0 })).toBe(
    "results.delivered",
  ));
it("does not call a partly unconfirmed audience fully delivered", () =>
  expect(
    mailboxDeliveryBadge("accepted", {
      ...empty,
      totalRecipients: 2,
      delivered: 1,
      unconfirmed: 1,
    }),
  ).toBe("deliveryStatus.partial"));
it("does not call delivered and bounced recipients fully delivered", () =>
  expect(
    mailboxDeliveryBadge("accepted", {
      ...empty,
      totalRecipients: 2,
      delivered: 1,
      hardBounce: 1,
      unconfirmed: 0,
    }),
  ).toBe("deliveryStatus.partial"));
it("shows a confirmed bounce instead of acceptance", () =>
  expect(mailboxDeliveryBadge("accepted", { ...empty, hardBounce: 1, unconfirmed: 0 })).toBe(
    "results.hardBounce",
  ));
it("never trusts inconsistent recipient counters", () =>
  expect(mailboxDeliveryBadge("accepted", { ...empty, delivered: 2 })).toBe(
    "deliveryStatus.accepted",
  ));
it("gives missing mixed-result locale keys a safe explicit English fallback", () => {
  const t = Object.assign((key: string) => key, { has: () => false });
  expect(
    mailboxDeliveryLabel(t, "accepted", {
      ...empty,
      totalRecipients: 2,
      delivered: 1,
      unconfirmed: 1,
    }),
  ).toBe("Mixed recipient outcomes");
});
