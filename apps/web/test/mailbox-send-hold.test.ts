import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../messages/en/mailboxes.json";
import pt from "../messages/pt-BR/mailboxes.json";
import {
  type MailboxSendHold,
  MailboxSendHoldNotice,
  mailboxSendHoldPresentation,
} from "../src/lib/mailbox-send-hold";

const hold: MailboxSendHold = {
  reason: "review_required",
  automaticRetry: true,
  actionRequired: "review",
  queuedSince: new Date("2026-11-12T10:00:00Z"),
  lastCheckedAt: new Date("2026-11-12T10:01:00Z"),
  nextRetryAt: null,
};
function translator(messages: unknown) {
  return (key: string): string => {
    let value = messages;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object" || !(part in value)) throw new Error(key);
      value = (value as Record<string, unknown>)[part];
    }
    if (typeof value !== "string") throw new Error(key);
    return value;
  };
}
const reasons = Object.keys(en.sendHold.reasons) as MailboxSendHold["reason"][];
const actions = Object.keys(en.sendHold.actions) as MailboxSendHold["actionRequired"][];
for (const [locale, messages] of [
  ["en", en],
  ["pt-BR", pt],
] as const) {
  const t = translator(messages);
  describe(locale, () => {
    for (const reason of reasons) {
      it(`renders the real notice for ${reason} with retry and action guidance`, () => {
        const source = { sendStatus: "queued", sendHold: { ...hold, reason } };
        const view = mailboxSendHoldPresentation(t, source);
        expect(view?.detail).toContain(t(`sendHold.reasons.${reason}`));
        expect(view?.detail).toContain(messages.sendHold.automaticRetry);
        expect(view?.detail).toContain(messages.sendHold.actions.review);
        expect(view?.detail).toContain(messages.sendHold.noResend);
        const html = renderToStaticMarkup(createElement(MailboxSendHoldNotice, { t, source }));
        expect(html).toContain('role="status"');
        expect(html).toContain(t(`sendHold.reasons.${reason}`));
        expect(html).not.toContain("<button");
      });
    }
    for (const actionRequired of actions) {
      it(`shows ${actionRequired} and no scheduled retry without inventing an ETA`, () => {
        const source = {
          sendStatus: "queued",
          sendHold: { ...hold, automaticRetry: false, actionRequired },
        };
        const view = mailboxSendHoldPresentation(t, source);
        expect(view?.detail).toContain(messages.sendHold.noAutomaticRetry);
        expect(view?.detail).toContain(t(`sendHold.actions.${actionRequired}`));
        expect(view?.detail).not.toContain("2026");
        const html = renderToStaticMarkup(
          createElement(MailboxSendHoldNotice, { t, source, variant: "badge" }),
        );
        expect(html).toContain('aria-label="');
        expect(html).toContain(t(`sendHold.actions.${actionRequired}`));
      });
    }
    it("preserves a generic queued state when no reason is supplied", () => {
      expect(mailboxSendHoldPresentation(t, { sendStatus: "queued" })).toBeNull();
      expect(mailboxSendHoldPresentation(t, { sendStatus: "queued", sendHold: null })).toBeNull();
    });
    for (const sendStatus of [
      "waiting",
      "requesting",
      "sending",
      "accepted",
      "unknown",
      "failed",
    ]) {
      it(`clears a stale hold for ${sendStatus}, without exposing resend`, () => {
        const source = { sendStatus, sendHold: hold };
        expect(mailboxSendHoldPresentation(t, source)).toBeNull();
        expect(renderToStaticMarkup(createElement(MailboxSendHoldNotice, { t, source }))).toBe("");
      });
    }
    it("keeps campaign unavailability distinct from a consent request", () => {
      expect(messages.sendHold.reasons.campaign_sending_disabled).not.toBe(
        messages.sendHold.reasons.campaign_consent_required,
      );
    });
    it("does not display an unrecognized wire reason or action", () => {
      const source = {
        sendStatus: "queued",
        sendHold: { ...hold, reason: "private_provider_error" } as unknown as MailboxSendHold,
      };
      expect(mailboxSendHoldPresentation(t, source)).toBeNull();
      source.sendHold = { ...hold, actionRequired: "release" } as unknown as MailboxSendHold;
      expect(mailboxSendHoldPresentation(t, source)).toBeNull();
    });
  });
}
it("has identical EN/PT hold keys", () => {
  expect(Object.keys(en.sendHold).sort()).toEqual(Object.keys(pt.sendHold).sort());
  expect(Object.keys(en.sendHold.reasons).sort()).toEqual(Object.keys(pt.sendHold.reasons).sort());
  expect(Object.keys(en.sendHold.actions).sort()).toEqual(Object.keys(pt.sendHold.actions).sort());
});
