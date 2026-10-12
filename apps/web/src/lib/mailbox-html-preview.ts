/**
 * A short plain-text preview of an HTML-only message, for the list. Cheap on
 * purpose: it reads only the start of the document and strips markup with a
 * few passes instead of converting the whole HTML to text. The reader keeps
 * the full conversion.
 */

const HEAD = 64 * 1024;
const LONGEST = 600;
const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  euro: "€",
};
// Accented letters: &aacute; &Atilde; &ccedil; and the like.
const ACCENTS: Record<string, string> = {
  acute: "́",
  grave: "̀",
  circ: "̂",
  tilde: "̃",
  uml: "̈",
  cedil: "̧",
  ring: "̊",
};

function decodeEntity(entity: string, name: string): string {
  if (name.startsWith("#x") || name.startsWith("#X")) {
    const code = Number.parseInt(name.slice(2), 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  }
  if (name.startsWith("#")) {
    const code = Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : entity;
  }
  const named = NAMED[name] ?? NAMED[name.toLowerCase()];
  if (named) return named;
  const accent = /^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring)$/.exec(name);
  if (accent) return `${accent[1]}${ACCENTS[accent[2]!]}`.normalize("NFC");
  return entity;
}

export function mailboxHtmlPreviewText(html: string | false | undefined | null): string {
  if (!html) return "";
  const text = html
    .slice(0, HEAD)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<head\b[\s\S]*?(?:<\/head\s*>|(?=<body\b)|$)/gi, " ")
    .replace(/<(style|script|title|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]{1,31});/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > LONGEST ? text.slice(0, LONGEST) : text;
}

/**
 * The whole HTML body as plain text, for a message whose text/plain part is missing or
 * blank (agents and the plain-text view read this). Comments (Outlook's [if mso] blocks),
 * the head, scripts and styles go; links keep their URL as "text (url)"; block ends become
 * line breaks; every entity is decoded once, in a single pass, so "&amp;lt;" stays "&lt;".
 */
export function mailboxHtmlText(html: string | false | undefined | null): string {
  if (!html) return "";
  return (
    html
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      // </head> is optional in HTML: the head also ends where <body starts.
      .replace(/<head\b[\s\S]*?(?:<\/head\s*>|(?=<body\b)|$)/gi, "")
      .replace(/<(style|script|title|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
      .replace(
        /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, inner: string) => `${inner.replace(/<[^>]+>/g, "")} (${href})`,
      )
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|table|pre|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]{1,31});/gi, decodeEntity)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
