import { describe, expect, it } from "vitest";
import { mailboxHtmlPreviewText } from "./mailbox-html-preview";

describe("mailboxHtmlPreviewText", () => {
  it("keeps the visible words of an HTML message and drops markup", () => {
    const html =
      "<html><head><title>Hidden</title><style>.a{color:red}</style></head><body><!-- note --><div class=a>Olá&nbsp;Jean,</div><p>Novidades <b>da semana</b><br>e mais.</p><script>alert(1)</script></body></html>";
    expect(mailboxHtmlPreviewText(html)).toBe("Olá Jean, Novidades da semana e mais.");
  });

  it("decodes numeric, named and accented entities", () => {
    expect(
      mailboxHtmlPreviewText(
        "<p>voc&ecirc; &amp; n&oacute;s &#8212; &#x2192; &copy; a&ccedil;&atilde;o</p>",
      ),
    ).toBe("você & nós — → © ação");
    expect(mailboxHtmlPreviewText("<p>&unknown; &#99999999;</p>")).toBe("&unknown; &#99999999;");
  });

  it("is empty without HTML and bounded for long documents", () => {
    expect(mailboxHtmlPreviewText(undefined)).toBe("");
    expect(mailboxHtmlPreviewText(false)).toBe("");
    expect(mailboxHtmlPreviewText(`<p>${"palavra ".repeat(500)}</p>`).length).toBe(600);
  });

  it("survives unclosed comments and blocks", () => {
    expect(mailboxHtmlPreviewText("<p>Antes</p><style>.x{}")).toBe("Antes");
    expect(mailboxHtmlPreviewText("<p>Antes</p><!-- sem fim")).toBe("Antes");
  });
});
