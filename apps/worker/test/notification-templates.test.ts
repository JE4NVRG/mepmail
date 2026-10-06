import {
  evaluateDeliverability,
  PAUSE_BOUNCE_RATE,
  PAUSE_COMPLAINT_RATE,
  WARN_BOUNCE_RATE,
} from "@millionsend/core";
import { expect, it } from "vitest";
import {
  deliverabilityPausedMail,
  deliverabilityWarningMail,
} from "../src/notifications/templates.js";

const base = { team: "Example", url: "https://mepmail.dev/metrics" };

it("the bounce warning distinguishes permanent suppression from transient failures", () => {
  const mail = deliverabilityWarningMail({
    ...base,
    metric: "bounce",
    rate: WARN_BOUNCE_RATE,
    limit: WARN_BOUNCE_RATE,
    windowDays: 7,
  });
  expect(mail.text).toContain("Hard-bounced addresses are automatically added");
  expect(mail.text).toContain("transient bounces alone do not add an address");
  expect(mail.text).not.toContain("every bounced address");
  expect(mail.text).toContain("UTC calendar days, including today");
  expect(mail.text).toContain("at or above the 4.00% risk line");
  expect(mail.html).toContain("transient bounces alone");
});

it.each([
  { metric: "bounce" as const, rate: PAUSE_BOUNCE_RATE, events: "10 hard bounces" },
  { metric: "complaint" as const, rate: PAUSE_COMPLAINT_RATE, events: "3 complaints" },
])("the $metric pause explains all independent criteria and the UTC decision window", (input) => {
  const mail = deliverabilityPausedMail({
    ...base,
    metric: input.metric,
    rate: input.rate,
    limit: input.rate,
    windowDays: 2,
  });
  expect(mail.text).toContain("today and yesterday (UTC)");
  expect(mail.text).toContain("all three conditions in that same window");
  expect(mail.text).toContain("at least 100 successfully sent messages");
  expect(mail.text).toContain(`at least ${input.events}`);
  expect(mail.text).toContain("New API and batch sends and new broadcast starts");
  expect(mail.text).not.toContain("last 24 hours");
  expect(mail.text).toContain("neither hard bounces nor complaints");
  expect(mail.text).toContain("score and the seven-day display do not unlock sending");
  expect(mail.text).toContain("operator or regional restrictions can still apply");
});

it("recovery can end the pause without either displayed rate or a score recovering", () => {
  const health = evaluateDeliverability({
    warn: { sent: 1_000, hardBounced: 80, complained: 4 },
    pause: { sent: 100, hardBounced: 9, complained: 2 },
  });
  expect(health.status).toBe("warning");
  expect(health.bounceRate).toBeGreaterThan(PAUSE_BOUNCE_RATE);
  const mail = deliverabilityPausedMail({
    ...base,
    metric: "bounce",
    rate: PAUSE_BOUNCE_RATE,
    limit: PAUSE_BOUNCE_RATE,
    windowDays: 2,
  });
  expect(mail.text).not.toContain("once the rate over the window drops back under");
  expect(mail.text).toContain("all of their pause conditions");
  expect(mail.text).toContain("warning throttles");
});
