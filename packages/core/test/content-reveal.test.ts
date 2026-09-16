import { describe, expect, it } from "vitest";
import {
  CONTENT_REVEAL_TEXT_MAX_CHARS,
  CONTENT_REVEAL_WINDOW_MS,
  contentRevealExpiry,
  type RevealedContent,
  redactRevealedText,
  renderRevealedBody,
} from "../src/content-reveal.js";

const plain = (content: RevealedContent) => content.spans.map((s) => s.text).join("");
const masked = (content: RevealedContent) =>
  content.spans.filter((s) => s.redacted).map((s) => s.text);

describe("redactRevealedText", () => {
  it("reduces a link to its registrable domain and a short path stub", () => {
    const content = redactRevealedText(
      "Confirm at https://login.secure.example.co.uk/reset?token=abcdefghijklmnopqrstuvwxyz0123 now.",
    );
    expect(plain(content)).toBe("Confirm at https://example.co.uk/reset?token=abcdefghijk… now.");
    expect(content.redactions).toBe(1);
  });

  it("keeps a short path whole and leaves sentence punctuation outside the link", () => {
    const content = redactRevealedText("See https://example.com/pricing.");
    expect(plain(content)).toBe("See https://example.com/pricing.");
    expect(masked(content)).toEqual(["https://example.com/pricing"]);
  });

  it("masks a one-time code named in English or Portuguese", () => {
    expect(plain(redactRevealedText("Your code is 483920, valid for 10 minutes."))).toBe(
      "Your code is ••••••, valid for 10 minutes.",
    );
    expect(plain(redactRevealedText("Digite o código 4821 no aplicativo."))).toBe(
      "Digite o código •••••• no aplicativo.",
    );
    expect(plain(redactRevealedText("Sua senha temporária: 99182734"))).toBe(
      "Sua senha temporária: ••••••",
    );
  });

  it("leaves numbers that follow no such word, and runs outside 4-8 digits", () => {
    const content = redactRevealedText("Invoice 4821 for 1200 items, order 123456789012.");
    expect(content.redactions).toBe(0);
    expect(plain(content)).toBe("Invoice 4821 for 1200 items, order 123456789012.");
  });

  it("stops looking for a code 40 characters past the word", () => {
    const far = `token ${"word ".repeat(9)} 123456`;
    expect(redactRevealedText(far).redactions).toBe(0);
  });

  it("masks a JWT, a long hex string and a long base64 blob", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
    const hex = "a".repeat(32);
    const b64 = `${"QUJD".repeat(11)}==`;
    const content = redactRevealedText(`t ${jwt} h ${hex} b ${b64} end`);
    expect(content.redactions).toBe(3);
    expect(plain(content)).toBe("t •••••• h •••••• b •••••• end");
  });

  it("marks every changed run as redacted and nothing else", () => {
    const content = redactRevealedText("Hi, your code is 111222 at https://example.com/a/b.");
    expect(masked(content)).toEqual(["••••••", "https://example.com/a/b"]);
    expect(content.spans.filter((s) => !s.redacted).map((s) => s.text)).toEqual([
      "Hi, your code is ",
      " at ",
      ".",
    ]);
  });

  it("keeps a bare address as the host: there is no domain to reduce it to", () => {
    expect(plain(redactRevealedText("go http://10.0.0.7/login/now"))).toBe(
      "go http://10.0.0.7/login/now",
    );
  });
});

describe("renderRevealedBody", () => {
  it("renders the visible text of the HTML, hidden elements and markup gone", () => {
    const content = renderRevealedBody({
      html:
        "<html><style>p{color:red}</style><body><p>Pay now &amp; keep the account</p>" +
        '<div style="display:none">stuffed keywords</div>' +
        '<a href="https://tracker.example.com/click/abcdefghijklmnopqrstuvwxyz">here</a></body></html>',
      text: null,
    });
    expect(plain(content)).toBe("Pay now & keep the account here");
    expect(content.redactions).toBe(0);
  });

  it("falls back to the plain-text part when there is no HTML", () => {
    const content = renderRevealedBody({ html: null, text: "  Your PIN is 4821  " });
    expect(plain(content)).toBe("Your PIN is ••••••");
  });

  it("cuts a long body at the character budget", () => {
    const long = "lorem ipsum ".repeat(CONTENT_REVEAL_TEXT_MAX_CHARS);
    const content = renderRevealedBody({ html: null, text: long });
    expect(plain(content)).toHaveLength(CONTENT_REVEAL_TEXT_MAX_CHARS + 1);
    expect(plain(content).endsWith("…")).toBe(true);
  });

  it("never returns a half-written mask at the cut", () => {
    const filler = "word "
      .repeat(CONTENT_REVEAL_TEXT_MAX_CHARS / 5)
      .slice(0, CONTENT_REVEAL_TEXT_MAX_CHARS - 2);
    const body = `${filler} code 1234 tail`;
    const content = renderRevealedBody({ html: null, text: body });
    expect(plain(content)).not.toContain("•");
    expect(content.redactions).toBe(0);
  });

  it("holds an empty body without spans", () => {
    expect(renderRevealedBody({ html: null, text: null })).toEqual({ spans: [], redactions: 0 });
  });
});

describe("contentRevealExpiry", () => {
  it("is thirty minutes after the grant", () => {
    const at = new Date("2026-09-16T10:00:00Z");
    expect(contentRevealExpiry(at).toISOString()).toBe("2026-09-16T10:30:00.000Z");
    expect(CONTENT_REVEAL_WINDOW_MS).toBe(1_800_000);
  });
});
