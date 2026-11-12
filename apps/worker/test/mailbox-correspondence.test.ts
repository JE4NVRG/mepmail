import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { campaignMessage } from "../../../packages/core/src/campaign-consent.js";
import {
  assertMailboxCorrespondenceRecipients,
  MAILBOX_CORRESPONDENCE_MAX_RECIPIENTS,
  mailboxCorrespondenceCampaign,
} from "../src/mailbox-correspondence.js";

const personal = {
  to: ["person@example.test"],
  cc: ["colleague@example.test"],
  subject: "Re: document review",
  text: "Can we meet tomorrow to discuss the document?",
};
it("Native personal To/Cc/reply-all stays transactional; public Send remains strict", () => {
  expect(mailboxCorrespondenceCampaign(personal)).toBe(false);
  expect(campaignMessage(personal)).toBe(true);
  expect(mailboxCorrespondenceCampaign({ ...personal, cc: [] })).toBe(false);
  expect(
    mailboxCorrespondenceCampaign({
      ...personal,
      cc: Array.from({ length: 6 }, (_, i) => `person${i}@example.test`),
    }),
  ).toBe(false);
});
it("matches existing composer ceiling and rejects empty/mass recipients at adapter boundary", () => {
  const transport = readFileSync(
    new URL("../../../packages/core/src/mailbox-transport.ts", import.meta.url),
    "utf8",
  );
  expect(transport).toContain(`const MAX_RECIPIENTS = ${MAILBOX_CORRESPONDENCE_MAX_RECIPIENTS};`);
  const bounded = {
    ...personal,
    cc: Array.from({ length: 19 }, (_, i) => `person${i}@example.test`),
  };
  expect(mailboxCorrespondenceCampaign(bounded)).toBe(false);
  expect(() => assertMailboxCorrespondenceRecipients(bounded)).not.toThrow();
  for (const invalid of [
    { ...bounded, bcc: ["extra@example.test"] },
    { to: [], cc: [] },
  ]) {
    expect(mailboxCorrespondenceCampaign(invalid)).toBe(true);
    expect(() => assertMailboxCorrespondenceRecipients(invalid)).toThrow();
  }
});
it.each([
  { declaredCampaign: true },
  { broadcastId: "broadcast" },
  { topicId: "topic" },
  { headers: { "LIST-ID": "members.example.test" } },
  { headers: { "List-Unsubscribe": "<https://example.test/unsubscribe>" } },
  { subject: "Black Friday special offer" },
  { text: "Newsletter course spotlight limited seats" },
  { text: "Promoção oferta exclusiva", declaredCampaign: false },
])("retains campaign signals without trusting a negative declaration: %j", (signal) => {
  expect(mailboxCorrespondenceCampaign({ ...personal, ...signal })).toBe(true);
});
