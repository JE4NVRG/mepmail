import { describe, expect, it } from "vitest";
import { initialMailboxText } from "../src/lib/mailbox-compose-signature";
import {
  type MailboxSignatureProfile,
  mailboxDraftHtml,
  mailboxSignatureHtml,
  mailboxSignatureText,
  mailboxTextToHtml,
} from "../src/lib/mailbox-signature";

const profile: MailboxSignatureProfile = {
  version: 1,
  name: "Jean Vargas",
  title: "Fundador",
  company: "MepMail",
  phone: "+55 44 99999-0000",
  website: "https://mepmail.dev/",
  logoUrl: "https://cdn.example.invalid/signature-logos/t/m.png?v=1",
  logoWidth: 480,
  logoHeight: 160,
};

describe("mailbox signature text", () => {
  it("lists name, title and company, phone and website, then the free lines", () => {
    expect(mailboxSignatureText({ profile, text: "  Atendimento 9h-18h  " })).toBe(
      "Jean Vargas\nFundador · MepMail\n+55 44 99999-0000 · mepmail.dev\nAtendimento 9h-18h",
    );
  });

  it("reads exactly as the old free text when there are no structured fields", () => {
    expect(mailboxSignatureText({ profile: null, text: "Jean\nMepMail" })).toBe("Jean\nMepMail");
    expect(mailboxSignatureText({ profile: null, text: "  " })).toBe("");
  });
});

describe("mailbox signature HTML", () => {
  it("escapes every field and links the phone and website", () => {
    const html = mailboxSignatureHtml({
      profile: { ...profile, name: '<img src=x onerror="alert(1)">', company: "A&B" },
      text: "<script>x</script>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A&amp;B");
    expect(html).toContain('href="tel:+5544999990000"');
    expect(html).toContain('href="https://mepmail.dev/"');
    expect(html).toContain(">mepmail.dev</a>");
  });

  it("gives the logo explicit pixel size within the email bounds", () => {
    const html = mailboxSignatureHtml({ profile, text: "" });
    // 480x160 at 48px tall is 144px wide; wider logos stop at 160px.
    expect(html).toContain('width="144" height="48"');
    const wide = mailboxSignatureHtml({
      profile: { ...profile, logoWidth: 480, logoHeight: 60 },
      text: "",
    });
    expect(wide).toContain('width="160" height="20"');
    const unknown = mailboxSignatureHtml({ profile: { ...profile, logoWidth: null }, text: "" });
    expect(unknown).toContain('width="96"');
  });

  it("is empty with nothing to show, and plain lines for a text-only signature", () => {
    expect(mailboxSignatureHtml({ profile: null, text: "" })).toBe("");
    expect(mailboxSignatureHtml({ profile: null, text: "Jean\nMepMail" })).toContain(
      "Jean<br>MepMail",
    );
  });
});

describe("mailbox text to HTML", () => {
  it("keeps paragraphs and line breaks, links URLs and escapes the rest", () => {
    expect(mailboxTextToHtml("Oi <b>Ana</b>,\nveja https://x.example/a?b=1&c=2.\n\nAbraço")).toBe(
      '<p style="margin:0 0 12px">Oi &lt;b&gt;Ana&lt;/b&gt;,<br>veja <a href="https://x.example/a?b=1&amp;c=2" style="color:#6741c5">https://x.example/a?b=1&amp;c=2</a>.</p><p style="margin:0 0 12px">Abraço</p>',
    );
  });

  it("turns quoted lines into a quote block", () => {
    const html = mailboxTextToHtml("Resposta\n\n> linha 1\n> linha 2");
    expect(html).toContain("<blockquote");
    expect(html).toContain("linha 1<br>linha 2");
  });
});

describe("mailbox draft HTML", () => {
  const source = { profile, text: "" };
  it("formats the managed signature footer the composer inserted", () => {
    const text = initialMailboxText("Olá!", mailboxSignatureText(source));
    const html = mailboxDraftHtml(text, source);
    expect(html).toContain("Olá!");
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain("Jean Vargas");
    expect(html).not.toContain("--<br>");
  });

  it("keeps the signature before a forwarded message", () => {
    const text = initialMailboxText("> Original", mailboxSignatureText(source), true);
    const html = mailboxDraftHtml(text, source);
    expect(html.indexOf("Jean Vargas")).toBeLessThan(html.indexOf("<blockquote"));
  });

  it("leaves a footer the author edited as plain text", () => {
    const html = mailboxDraftHtml("Olá!\n\n--\nJean (editado)", source);
    expect(html).not.toContain("<table");
    expect(html).toContain("Jean (editado)");
  });
});
