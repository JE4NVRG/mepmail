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

const newsletterConversations = [
  {
    name: "individual public-profile pitch references newsletter placement and invites direct reply",
    subject: "A small one-time option",
    text: "We noticed ExampleCo in a developer publication. We offer a one-time public profile, not a newsletter insertion.\n\nIf useful, use the page or reply here. Email is the easiest way to reach us.",
  },
  {
    name: "Portuguese public-profile proposal invites reply without a question mark",
    subject: "Uma opção pontual",
    text: "Vi o histórico de vocês. Temos uma opção de perfil público, não outra inserção em newsletter.\n\nSe fizer sentido, responda aqui para conversarmos.",
  },
  {
    name: "individual pitch references earlier newsletter sponsorship before closing question",
    subject: "A small one-time option",
    text: "An industry record shows ExampleCo advertising in developer newsletters. We offer a smaller one-time sponsor profile, not another newsletter insertion.\n\nWould you like to discuss this option?",
  },
  {
    name: "Portuguese business context can precede closing question",
    subject: "Uma opção pontual",
    text: "Vi o histórico de patrocínio de vocês em newsletter. Temos uma opção de parceria pontual, sem enviar outra newsletter.\n\nPodemos conversar sobre os detalhes?",
  },
  {
    name: "ordinary sponsorship noun phrase ending a sentence",
    subject: "Business question",
    text: "Hello editor, I would like to discuss sponsorship of the newsletter. Could we talk about availability?",
  },
  {
    name: "first-person read-more request is not a distribution CTA",
    subject: "Business question",
    text: "Hello editor, could we discuss sponsorship of your newsletter? I would like to read more about your advertising options.",
  },
  {
    name: "question about reading more is not a distribution CTA",
    subject: "Re: Newsletter sponsorship",
    text: "Could we discuss newsletter sponsorship? Can I read more about your partnership options?",
  },
  {
    name: "English inquiry with ordinary subject and edition terms",
    subject: "A quick business question",
    text: "Hello editor, I read your newsletter and would like to discuss sponsorship of an upcoming weekly edition. Are you open to a partnership?",
  },
  {
    name: "Portuguese inquiry with ordinary subject and edition terms",
    subject: "Uma pergunta rápida",
    text: "Olá, acompanho sua newsletter e gostaria de conversar sobre patrocínio de uma edição semanal. Vocês têm espaço para uma parceria?",
  },
  {
    name: "English reply and ordinary CC",
    subject: "Re: Newsletter sponsorship",
    text: "Thanks for the newsletter sponsorship details. Could we discuss the partnership timing?",
    cc: ["colleague@example.test"],
  },
  {
    name: "Portuguese ordinary discussion",
    subject: "Re: parceria",
    text: "Podemos conversar sobre o patrocínio da newsletter e a próxima edição?",
    cc: ["colleague@example.test"],
  },
  {
    name: "HTML sponsorship question",
    subject: "Business question",
    html: "<p>Hello, could we discuss sponsorship of your newsletter and an upcoming edition?</p>",
  },
  {
    name: "neutral newsletter subject, sponsorship only in body",
    subject: "An idea for your newsletter",
    text: "Hello editor, could we discuss sponsorship of an upcoming edition of your newsletter?",
  },
];
it.each(newsletterConversations)(
  "Native newsletter conversation: $name",
  ({ name: _name, ...message }) => {
    const input = { to: ["editor@example.test"], ...message };
    expect(mailboxCorrespondenceCampaign(input)).toBe(false);
    expect(campaignMessage(input)).toBe(true);
    expect(mailboxCorrespondenceCampaign({ ...input, declaredCampaign: false })).toBe(false);
  },
);
const newsletterDistributions = [
  {
    name: "newsletter distribution remains blocked even with public-profile offer and reply invitation",
    subject: "Our weekly newsletter",
    text: "Our weekly newsletter: public profile and sponsorship news. Reply here for more details.",
  },
  {
    name: "standalone read-more imperative remains distribution",
    subject: "Newsletter sponsorship",
    text: "Could we discuss newsletter sponsorship? Read more about our products online.",
  },
  {
    name: "single weekly distribution",
    subject: "Our weekly newsletter",
    text: "Hello reader, here are the latest stories from our weekly newsletter.",
  },
  {
    name: "distribution despite sponsorship and question",
    subject: "Newsletter sponsorship",
    text: "Would you consider sponsorship? Welcome to our weekly newsletter. In this edition we share the latest news.",
  },
  {
    name: "unrelated promotion after sponsorship preface",
    subject: "Business question",
    text: "Could we discuss newsletter sponsorship? Buy now and save on all products.",
  },
  {
    name: "Portuguese promotional CTA",
    subject: "Parceria",
    text: "Podemos conversar sobre patrocínio da newsletter? Compre agora com desconto.",
  },
  {
    name: "newsletter unsubscribe",
    subject: "Business question",
    text: "Could we discuss newsletter sponsorship? Unsubscribe here.",
  },
  {
    name: "newsletter list ID",
    subject: "Business question",
    text: "Could we discuss newsletter sponsorship?",
    headers: {
      "List-ID": "members.example.test",
    },
  },
  {
    name: "bare newsletter remains strict",
    subject: "Newsletter",
    text: "Hello there.",
  },
  {
    name: "unrelated sponsorship is not an exemption",
    subject: "Sponsorship question",
    text: "Could we discuss sponsorship?\n\nOur weekly newsletter covers our latest stories.",
  },
  {
    name: "newsletter sign up CTA",
    text: "Could we discuss newsletter sponsorship? Subscribe now.",
  },
  {
    name: "Portuguese distribution",
    text: "Olá, bem-vindo à nossa newsletter semanal. Nesta edição trazemos as últimas notícias.",
  },
];
it.each(newsletterDistributions)(
  "retains newsletter/marketing restrictions: $name",
  ({ name: _name, ...message }) => {
    expect(
      mailboxCorrespondenceCampaign({
        to: ["reader@example.test"],
        ...message,
        declaredCampaign: false,
      }),
    ).toBe(true);
  },
);

it("sponsorship prefaces cannot exempt a newsletter distribution heading", () => {
  expect(
    mailboxCorrespondenceCampaign({
      to: ["reader@example.test"],
      subject: "Newsletter sponsorship",
      text: "Could we discuss sponsorship? Our weekly newsletter: product updates and company announcements.",
    }),
  ).toBe(true);
});
it("contextual newsletter inquiries retain every explicit campaign restriction", () => {
  const inquiry = { to: ["editor@example.test"], text: "Could we discuss newsletter sponsorship?" };
  for (const signal of [
    { declaredCampaign: true },
    { broadcastId: "broadcast" },
    { topicId: "topic" },
    { headers: { "List-ID": "list.example.test" } },
    { headers: { "List-Unsubscribe": "<https://example.test/unsubscribe>" } },
    { subject: "Black Friday special offer" },
  ]) {
    expect(mailboxCorrespondenceCampaign({ ...inquiry, ...signal })).toBe(true);
  }
  expect(mailboxCorrespondenceCampaign({ ...inquiry, to: [] })).toBe(true);
  expect(
    mailboxCorrespondenceCampaign({
      ...inquiry,
      cc: Array.from({ length: 20 }, (_, i) => `person${i}@example.test`),
    }),
  ).toBe(true);
  expect(mailboxCorrespondenceCampaign({ ...inquiry, html: "<p>Our weekly newsletter</p>" })).toBe(
    true,
  );
});
