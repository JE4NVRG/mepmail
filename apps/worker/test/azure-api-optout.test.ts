import { describe, expect, it } from "vitest";
import { appendAzureApiOptoutBody } from "../src/azure-api-optout.js";

// Pure formatting evidence only. Signed tokens, endpoint and SQL suppression
// are exercised by the recipient-optout route and integrated worker suites.
const url = "https://mail.example.test/unsubscribe/recipient/SYNTHETIC_TEST_TOKEN";
const from = "sender@example.test";

describe("ACS API required identity and opt-out body", () => {
  it("keeps a transactional text body and appends explicit all-message scope", () => {
    const result = appendAzureApiOptoutBody({
      from,
      text: "Your requested sign-in code: TEST",
      html: null,
      url,
    });
    expect(result.html).toBeNull();
    expect(result.text).toContain("Your requested sign-in code: TEST");
    expect(result.text).toContain(from);
    expect(result.text).toContain("Parar de receber todas as mensagens desta equipe");
    expect(result.text).toContain("Stop all messages from this team");
    expect(result.text).toContain(url);
  });

  it("puts a visible generated footer before the HTML closing body", () => {
    const result = appendAzureApiOptoutBody({
      from,
      text: null,
      html: "<html><body><p>Receipt TEST</p></body></html>",
      url,
    });
    expect(result.html).toContain('<a href="' + url + '"');
    expect(result.html).toContain("display:block!important");
    expect(result.html?.indexOf(url)).toBeLessThan(result.html?.indexOf("</body>") ?? 0);
    expect(result.html).toContain("<p>Receipt TEST</p>");
    expect(result.text).toContain(url);
  });

  it("escapes identity rather than injecting caller HTML into the footer", () => {
    const result = appendAzureApiOptoutBody({
      from: '<script>alert("TEST")</script>',
      text: null,
      html: "<p>Content</p>",
      url,
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("always labels the scope even when an untrusted body already mentioned the URL", () => {
    const result = appendAzureApiOptoutBody({
      from,
      text: "Documentation: " + url,
      html: '<a href="' + url + '">Read more</a>',
      url,
    });
    expect(result.text).toContain("Stop all messages from this team: " + url);
    expect(result.html).toContain("Stop all messages from this team</a>");
  });

  it("handles attachment-only messages with an actual text explanation", () => {
    expect(appendAzureApiOptoutBody({ from, text: null, html: null, url }).text).toContain(
      "Sent by: " + from,
    );
  });

  it("is deterministic from the same immutable submission", () => {
    const input = { from, text: "TEST", html: "<p>TEST</p>", url };
    expect(appendAzureApiOptoutBody(input)).toEqual(appendAzureApiOptoutBody(input));
    expect(input).toEqual({ from, text: "TEST", html: "<p>TEST</p>", url });
  });

  it.each([
    "http://mail.example.test/unsubscribe/recipient/TEST",
    "https://user:pass@mail.example.test/unsubscribe/recipient/TEST",
    "https://mail.example.test/unsubscribe/recipient/TEST?redirect=TEST",
    "https://mail.example.test/unsubscribe/recipient/TEST#TEST",
    "https://mail.example.test/unsubscribe/recipient/",
    "https://mail.example.test/not-an-optout/TEST",
  ])("refuses an invalid provider opt-out URL: %s", (badUrl) => {
    expect(() =>
      appendAzureApiOptoutBody({ from, text: "TEST", html: null, url: badUrl }),
    ).toThrow();
  });

  it("rejects empty or header-injected sender identity", () => {
    for (const badFrom of ["", "sender@example.test\r\nBcc: other@example.test"]) {
      expect(() =>
        appendAzureApiOptoutBody({ from: badFrom, text: "TEST", html: null, url }),
      ).toThrow();
    }
  });
});
