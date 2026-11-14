import { JUDGE_LINK_ROWS_MAX, JUDGE_TEXT_MAX_CHARS } from "./abuse-judge/block.js";

/** Explicit scalar checks avoid decoder replacement and control-regex lint escapes. */
export function hasUnsafeDispatchCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      code === 0xad ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return true;
  }
  return false;
}

// This is a recognizer for a deliberately small HTML/CSS language, NOT a
// browser HTML parser. Anything requiring error recovery or CSS evaluation holds.
// Every text node (including title and hidden/preheader text) and full href is
// projected. No author image, active resource, comment or unknown attribute passes.
const TAGS = new Set(
  "html head body title style p div span br b strong em i u ul ol li table tbody thead tfoot tr td th h1 h2 h3 h4 h5 h6 a hr".split(
    " ",
  ),
);
const VOID = new Set(["br", "hr", "meta"]);
const PHRASING = new Set("span br b strong em i u a".split(" "));
const COLOR =
  /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|black|white|gray|grey|red|green|blue|navy|transparent)$/i;
const LENGTH = /^(?:0|[0-9]{1,3}(?:\.[0-9]{1,2})?(?:px|pt|em|rem|%))$/;
function cssDeclarations(css: string): boolean {
  if (/[\\@(){}<>/&]/.test(css) || hasUnsafeDispatchCharacters(css)) return false;
  const declarations = css.split(";");
  if (!declarations.at(-1)?.trim()) declarations.pop();
  return declarations.every((declaration) => {
    const pair = declaration.trim().split(":");
    if (pair.length !== 2) return false;
    const property = pair[0]!.trim().toLowerCase();
    const value = pair[1]!.trim().toLowerCase();
    if (/^(?:color|background-color|border-color)$/.test(property)) return COLOR.test(value);
    if (/^(?:padding|margin)(?:-(?:top|right|bottom|left))?$/.test(property))
      return value.split(/\s+/).length <= 4 && value.split(/\s+/).every((v) => LENGTH.test(v));
    if (/^(?:font-size|width|max-width|height|border-width|border-radius)$/.test(property))
      return LENGTH.test(value);
    if (property === "font-family")
      return /^(?:arial|helvetica|sans-serif|serif|monospace)(?:\s*,\s*(?:arial|helvetica|sans-serif|serif|monospace))*$/.test(
        value,
      );
    if (property === "font-weight") return /^(?:normal|bold|[1-9]00)$/.test(value);
    if (property === "font-style") return /^(?:normal|italic)$/.test(value);
    if (property === "line-height")
      return /^(?:normal|[1-3](?:\.[0-9]{1,2})?)$/.test(value) || LENGTH.test(value);
    if (property === "text-align") return /^(?:left|right|center|justify)$/.test(value);
    if (property === "text-decoration") return /^(?:none|underline|line-through)$/.test(value);
    if (property === "border-collapse") return /^(?:collapse|separate)$/.test(value);
    if (property === "border-style") return /^(?:none|solid|dashed|dotted)$/.test(value);
    // Hiding never removes text from our projection. No cascade is interpreted.
    if (property === "display")
      return /^(?:none|block|inline|inline-block|table|table-row|table-cell)$/.test(value);
    if (property === "visibility") return /^(?:visible|hidden)$/.test(value);
    return false;
  });
}
function stylesheet(css: string): boolean {
  let rest = css.trim();
  while (rest) {
    const open = rest.indexOf("{");
    const close = rest.indexOf("}", open + 1);
    if (open < 1 || close < 0) return false;
    const selector = rest.slice(0, open).trim();
    if (
      !selector
        .split(",")
        .every((s) =>
          /^(?:[a-z][a-z0-9]*|[.#][a-z][a-z0-9_-]*)(?:\s+(?:[a-z][a-z0-9]*|[.#][a-z][a-z0-9_-]*))*$/i.test(
            s.trim(),
          ),
        )
    )
      return false;
    if (!cssDeclarations(rest.slice(open + 1, close))) return false;
    rest = rest.slice(close + 1).trim();
  }
  return true;
}
function decode(value: string): string | null {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  let invalid = false;
  const decoded = value.replace(/&([^;\s]*);?/g, (whole, entity: string) => {
    if (!whole.endsWith(";")) {
      invalid = true;
      return whole;
    }
    if (Object.hasOwn(entities, entity)) return entities[entity]!;
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) {
      invalid = true;
      return whole;
    }
    const code =
      entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    if (code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      invalid = true;
      return whole;
    }
    return String.fromCodePoint(code);
  });
  return invalid || hasUnsafeDispatchCharacters(decoded) ? null : decoded;
}
function childAllowed(tag: string, stack: string[]): boolean {
  const parent = stack.at(-1);
  if (tag === "html") return !parent;
  if (tag === "head" || tag === "body") return parent === "html";
  if (parent === "html" || parent === "title") return false;
  if (parent === "head") return ["title", "style", "meta"].includes(tag);
  if (["title", "style"].includes(tag)) return false;
  if (["table", "thead", "tbody", "tfoot", "tr"].includes(parent ?? "")) {
    const allowed: Record<string, string[]> = {
      table: ["thead", "tbody", "tfoot", "tr"],
      thead: ["tr"],
      tbody: ["tr"],
      tfoot: ["tr"],
      tr: ["td", "th"],
    };
    return allowed[parent!]!.includes(tag);
  }
  if (["thead", "tbody", "tfoot", "tr", "td", "th"].includes(tag)) return false;
  if (parent === "ul" || parent === "ol") return tag === "li";
  if (tag === "li" && parent !== "ul" && parent !== "ol") return false;
  if (stack.some((t) => t === "p" || /^h[1-6]$/.test(t) || PHRASING.has(t)))
    return PHRASING.has(tag) && !(tag === "a" && stack.includes("a"));
  return tag !== "meta";
}

/** null is an explicit HOLD, never a partial/truncated projection. */
export function projectDispatchHtml(html: string): string | null {
  if (html.length > 64_000 || decode(html) === null) return null;
  let cursor = 0;
  let output = "";
  let links = 0;
  let document = false;
  let head = false;
  let body = false;
  let closedDocument = false;
  let seenElement = false;
  const stack: string[] = [];
  if (/^\s*<!doctype html>/i.test(html)) {
    cursor = /^\s*<!doctype html>/i.exec(html)![0].length;
    document = true;
  }
  while (cursor < html.length) {
    if (html[cursor] !== "<") {
      const end = html.indexOf("<", cursor);
      const raw = html.slice(cursor, end < 0 ? html.length : end);
      const text = decode(raw);
      if (
        text === null ||
        (text.trim() &&
          (closedDocument ||
            ["html", "head", "table", "tbody", "thead", "tfoot", "tr", "ul", "ol"].includes(
              stack.at(-1) ?? "",
            ) ||
            (document && !stack.length)))
      )
        return null;
      output += text;
      cursor += raw.length;
      continue;
    }
    cursor++;
    const closing = html[cursor] === "/";
    if (closing) cursor++;
    const nameMatch = /^[a-z][a-z0-9]*/i.exec(html.slice(cursor));
    if (!nameMatch) return null;
    const tag = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    if ((!TAGS.has(tag) && tag !== "meta") || closedDocument) return null;
    if (closing) {
      const tail = /^\s*>/.exec(html.slice(cursor));
      if (!tail || VOID.has(tag) || stack.pop() !== tag) return null;
      cursor += tail[0].length;
      if (tag === "html") closedDocument = true;
      if (!PHRASING.has(tag)) output += "\n";
      continue;
    }
    if (!childAllowed(tag, stack) || (tag === "html" && (seenElement || output.trim())))
      return null;
    seenElement = true;
    if (tag === "html") {
      if (body || head) return null;
      document = true;
    }
    if (tag === "head") {
      if (head || body) return null;
      head = true;
    }
    if (tag === "body") {
      if (body) return null;
      body = true;
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      const space = /^\s*/.exec(html.slice(cursor))![0];
      cursor += space.length;
      if (html.startsWith("/>", cursor)) {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (html[cursor] === ">") {
        cursor++;
        break;
      }
      if (!space) return null;
      const attr = /^([a-z][a-z0-9-]*)\s*=\s*(["'])/i.exec(html.slice(cursor));
      if (!attr) return null;
      cursor += attr[0].length;
      const end = html.indexOf(attr[2]!, cursor);
      if (end < 0) return null;
      const raw = html.slice(cursor, end);
      if (/[<>]/.test(raw)) return null;
      const value = decode(raw);
      const key = attr[1]!.toLowerCase();
      if (value === null || attrs.has(key)) return null;
      attrs.set(key, value);
      cursor = end + 1;
    }
    if (selfClosing && !VOID.has(tag)) return null;
    for (const [key, value] of attrs) {
      if (key === "style" && tag !== "style" && tag !== "meta") {
        if (!cssDeclarations(value)) return null;
      } else if (key === "class" || key === "id") {
        if (!/^[a-z][a-z0-9_ -]*$/i.test(value)) return null;
      } else if (key === "lang" && tag === "html") {
        if (!/^[a-z]{2}(?:-[a-z]{2})?$/i.test(value)) return null;
      } else if (key === "href" && tag === "a") {
        if (!/^https?:\/\//i.test(value) || /[\s<>"'\\]/.test(value)) return null;
        try {
          const url = new URL(value);
          if (!url.hostname || url.username || url.password) return null;
        } catch {
          return null;
        }
        output += `\nLink destination: ${value}\n`;
      } else if (key === "charset" && tag === "meta" && value.toLowerCase() === "utf-8") {
        /* declaration only */
      } else if (key === "title" && tag !== "meta" && tag !== "style") output += `\n${value}\n`;
      else if (
        ["cellpadding", "cellspacing", "border", "width", "height", "colspan", "rowspan"].includes(
          key,
        ) &&
        ["table", "td", "th"].includes(tag)
      ) {
        if (!/^\d{1,3}%?$/.test(value)) return null;
      } else if (key === "align" && ["table", "td", "th", "p", "div"].includes(tag)) {
        if (!/^(?:left|right|center)$/.test(value)) return null;
      } else return null;
    }
    if (tag === "meta" && (attrs.size !== 1 || !attrs.has("charset"))) return null;
    if (tag === "a" && (!attrs.has("href") || ++links > JUDGE_LINK_ROWS_MAX)) return null;
    if (tag === "style") {
      if (attrs.size) return null;
      const end = html.toLowerCase().indexOf("</style>", cursor);
      if (end < 0 || !stylesheet(html.slice(cursor, end))) return null;
      cursor = end + "</style>".length;
    } else if (!VOID.has(tag)) stack.push(tag);
    if (!PHRASING.has(tag)) output += "\n";
  }
  if (stack.length || (document && (!body || !closedDocument))) return null;
  // Keep all projected content; the existing judge must never slice it.
  return output.length <= JUDGE_TEXT_MAX_CHARS ? output : null;
}
