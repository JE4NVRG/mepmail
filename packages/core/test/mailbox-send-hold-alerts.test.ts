import { expect, it } from "vitest";
import {
  MAILBOX_SEND_HOLD_ALERT_AFTER_MS,
  MAILBOX_SEND_HOLD_ALERT_COOLDOWN_MS,
  mailboxSendHoldAlertDecision,
} from "../src/mailbox-send-hold-alerts.js";

const now = new Date("2026-11-12T12:00:00Z");
const previous = { kind: "mailbox.send_hold.retained" as const, createdAt: now };
const stale = { count: 1, oldestAt: new Date(now.getTime() - MAILBOX_SEND_HOLD_ALERT_AFTER_MS) };

it.each(["sending", "unknown"])("does not report recovery during an old %s attempt", () => {
  expect(mailboxSendHoldAlertDecision(null, previous, now, true)).toBeNull();
});
it("a transient claim gap cannot reset reminder cooldown", () => {
  expect(mailboxSendHoldAlertDecision(null, previous, now, true)).toBeNull();
  expect(
    mailboxSendHoldAlertDecision(stale, previous, new Date(now.getTime() + 60000), false),
  ).toBeNull();
});
it("confirmed absence recovers once, but uncertainty never grants a resend", () => {
  expect(mailboxSendHoldAlertDecision(null, previous, now, false)).toBe("recovered");
  expect(
    mailboxSendHoldAlertDecision(
      null,
      { kind: "mailbox.send_hold.recovered", createdAt: now },
      now,
      false,
    ),
  ).toBeNull();
});
it("uncertainty does not suppress retained alerts or reminders", () => {
  expect(mailboxSendHoldAlertDecision(stale, null, now, true)).toBe("retained");
  expect(
    mailboxSendHoldAlertDecision(
      stale,
      previous,
      new Date(now.getTime() + MAILBOX_SEND_HOLD_ALERT_COOLDOWN_MS),
      true,
    ),
  ).toBe("retained");
});
