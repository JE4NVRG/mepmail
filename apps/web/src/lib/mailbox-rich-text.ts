/**
 * The Correio composer writes formatted text (bold, italic, links, lists,
 * quotes) and still sends a plain-text part next to the HTML. These helpers
 * move between the two: plain text into the editor (drafts saved before
 * formatting existed, replies that quote with "> "), and the editor's document
 * back into plain text that reads well in any mail app.
 */

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Paragraphs split at blank lines; single line breaks inside one stay as <br>. */
function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/**
 * Plain text as editor HTML: runs of lines starting with ">" become one
 * quote (one level; deeper markers stay as text inside it), the rest
 * paragraphs. An empty text is one empty paragraph.
 */
export function plainToEditorHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const parts: string[] = [];
  let plain: string[] = [];
  let quoted: string[] = [];
  const flushPlain = () => {
    if (plain.length) parts.push(paragraphs(plain.join("\n")));
    plain = [];
  };
  const flushQuote = () => {
    if (quoted.length)
      parts.push(`<blockquote>${paragraphs(quoted.join("\n")) || "<p></p>"}</blockquote>`);
    quoted = [];
  };
  for (const line of lines) {
    if (/^>/.test(line)) {
      flushPlain();
      quoted.push(line.replace(/^> ?/, ""));
    } else {
      flushQuote();
      plain.push(line);
    }
  }
  flushPlain();
  flushQuote();
  // A body that starts with a blank line (a new message or a reply above the
  // signature) keeps an empty first line to write on.
  const lead = /^[ \t]*\n/.test(text) && parts.length ? "<p></p>" : "";
  return lead + parts.join("") || "<p></p>";
}

/** The parts of a ProseMirror JSON document the composer produces. */
export type EditorNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: EditorNode[];
};

/** Inline content as text: a link whose text is not its address carries it in parentheses. */
function inline(nodes: EditorNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === "hardBreak") return "\n";
      if (node.type !== "text") return inline(node.content);
      const text = node.text ?? "";
      const link = node.marks?.find((mark) => mark.type === "link");
      const href = typeof link?.attrs?.href === "string" ? link.attrs.href : null;
      return href && href !== text && href !== `mailto:${text}` ? `${text} (${href})` : text;
    })
    .join("");
}

/** Block content as lines, blocks separated by one blank line. */
function blocks(nodes: EditorNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      switch (node.type) {
        case "paragraph":
        case "heading":
          return inline(node.content);
        case "blockquote":
          return blocks(node.content)
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n");
        case "bulletList":
          return (node.content ?? [])
            .map((item) => indentItem("- ", blocks(item.content)))
            .join("\n");
        case "orderedList": {
          const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
          return (node.content ?? [])
            .map((item, index) => indentItem(`${start + index}. `, blocks(item.content)))
            .join("\n");
        }
        case "codeBlock":
          return inline(node.content);
        default:
          return blocks(node.content);
      }
    })
    .join("\n\n");
}

/** A list item's text after its marker, later lines lined up under the first. */
function indentItem(marker: string, text: string): string {
  const pad = " ".repeat(marker.length);
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? `${marker}${line}` : line ? `${pad}${line}` : ""))
    .join("\n");
}

/** The editor's document as the plain-text part of the message. */
export function editorDocToPlain(doc: EditorNode): string {
  return blocks(doc.content)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/** Whether the document has anything plain text cannot say (marks, lists, quotes, links). */
export function editorDocIsFormatted(doc: EditorNode): boolean {
  const visit = (node: EditorNode): boolean =>
    ["bulletList", "orderedList", "blockquote", "heading", "codeBlock"].includes(node.type) ||
    (node.marks?.length ?? 0) > 0 ||
    (node.content ?? []).some(visit);
  return visit(doc);
}
