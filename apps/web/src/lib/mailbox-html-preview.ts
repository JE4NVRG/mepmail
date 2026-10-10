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
    .replace(/<(head|style|script|title|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]{1,31});/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > LONGEST ? text.slice(0, LONGEST) : text;
}
