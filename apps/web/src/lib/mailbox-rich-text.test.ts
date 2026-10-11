import { describe, expect, it } from "vitest";
import {
  type EditorNode,
  editorDocIsFormatted,
  editorDocToPlain,
  plainToEditorHtml,
} from "./mailbox-rich-text";

const p = (...content: EditorNode[]): EditorNode => ({ type: "paragraph", content });
const text = (value: string, marks?: EditorNode["marks"]): EditorNode => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const doc = (...content: EditorNode[]): EditorNode => ({ type: "doc", content });

describe("plain text into the editor", () => {
  it("keeps paragraphs and line breaks, and escapes markup", () => {
    expect(plainToEditorHtml("Oi Maya,\n\nSegue <o contrato> & o PDF.\n--\nJean")).toBe(
      "<p>Oi Maya,</p><p>Segue &lt;o contrato&gt; &amp; o PDF.<br>--<br>Jean</p>",
    );
    expect(plainToEditorHtml("")).toBe("<p></p>");
  });

  it("keeps an empty first line above a signature to write on", () => {
    expect(plainToEditorHtml("\n\n--\nJean")).toBe("<p></p><p>--<br>Jean</p>");
  });

  it("turns a quoted reply into one quote", () => {
    expect(
      plainToEditorHtml("Combinado!\n\nEm 10/10, Maya escreveu:\n> Podemos falar?\n>\n> Abraço"),
    ).toBe(
      "<p>Combinado!</p><p>Em 10/10, Maya escreveu:</p><blockquote><p>Podemos falar?</p><p>Abraço</p></blockquote>",
    );
  });
});

describe("the editor's document as plain text", () => {
  it("writes paragraphs, quotes, lists and links that read well anywhere", () => {
    const value = editorDocToPlain(
      doc(
        p(text("Oi "), text("Maya", [{ type: "bold" }]), text(",")),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(text("Contrato"))] },
            { type: "listItem", content: [p(text("Proposta"))] },
          ],
        },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [{ type: "listItem", content: [p(text("Assinar"))] }],
        },
        p(
          text("Veja "),
          text("o site", [{ type: "link", attrs: { href: "https://mepmail.dev" } }]),
          text(" ou "),
          text("jean@mepmail.dev", [{ type: "link", attrs: { href: "mailto:jean@mepmail.dev" } }]),
        ),
        { type: "blockquote", content: [p(text("Podemos falar?")), p(text("Abraço"))] },
      ),
    );
    expect(value).toBe(
      [
        "Oi Maya,",
        "- Contrato\n- Proposta",
        "1. Assinar",
        "Veja o site (https://mepmail.dev) ou jean@mepmail.dev",
        "> Podemos falar?\n>\n> Abraço",
      ].join("\n\n"),
    );
  });

  it("keeps line breaks inside a paragraph", () => {
    expect(editorDocToPlain(doc(p(text("--"), { type: "hardBreak" }, text("Jean"))))).toBe(
      "--\nJean",
    );
  });

  it("tells formatted text from plain text", () => {
    expect(editorDocIsFormatted(doc(p(text("só texto"))))).toBe(false);
    expect(editorDocIsFormatted(doc(p(text("forte", [{ type: "bold" }]))))).toBe(true);
    expect(editorDocIsFormatted(doc({ type: "blockquote", content: [p(text("x"))] }))).toBe(true);
  });
});
