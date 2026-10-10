import sanitizeHtml from "sanitize-html";
import { pilotImageMetadata } from "../../../../packages/core/src/mailbox-pilot-images";

type InlineAttachment = { contentId?: string | undefined; content: Buffer };
/** HTML read for display: a longer body is cut here (the sanitizer closes what the cut opens). */
const MAX_HTML = 5 * 1024 * 1024;
/** Inline images turned into data: URLs, all together. */
const MAX_INLINE = 2 * 1024 * 1024;
const HOST_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const SIZE = /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))$/;
/** padding as email buttons write it: one to four lengths ("12px 24px"). */
const PADDING =
  /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))(?:\s+(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))){0,3}$/;
/** margin likewise, plus auto for centring ("0 auto"); never negative. */
const MARGIN =
  /^(?:auto|0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))(?:\s+(?:auto|0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))){0,3}$/;
const MARGIN_SIDE = /^(?:auto|0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%))$/;
/** What a shown CSS background image becomes once its URL passed externalImage. */
const BACKGROUND_IMAGE = /^url\("https:\/\/[^"\\\s]+"\)$/;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
const CSS_COLOR = /#[\da-f]{3,8}\b|rgba?\([\d\s.,%]+\)/i;
/** Shown in place of a hidden image: its alt text, readable inside font-size:0 email cells. */
const PLACEHOLDER_STYLE = "font-size:12px;line-height:1.4;color:#80868b";
/** A 0-2 px image is a tracking pixel: never shown, never offered. */
const TINY = /^\s*[0-2](?:px)?\s*$/;
const TINY_STYLE_WIDTH = /(?:^|;)\s*width\s*:\s*[0-2](?:px)?\s*(?:;|$)/i;
const TINY_STYLE_HEIGHT = /(?:^|;)\s*height\s*:\s*[0-2](?:px)?\s*(?:;|$)/i;
const COLOR = /^(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\))$/i;
/** Table attributes keep only plain values: a colour or a length, never a URL. */
const LENGTH_ATTR = /^\d{1,4}%?$/;
const BORDER =
  /^(?:0|none|\d{1,2}px(?:\s+(?:solid|dashed|dotted|none))?(?:\s+(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\)))?)$/i;

function contentId(value: string) {
  return value.trim().replace(/^<|>$/g, "");
}
/** A plain pixel width/height (a signature logo's display size); nothing else. */
function imageSize(attrs: sanitizeHtml.Attributes) {
  const size: Record<string, string> = {};
  for (const name of ["width", "height"])
    if (/^\d{1,4}$/.test(attrs[name] ?? "")) size[name] = attrs[name] as string;
  return size;
}
function externalImage(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !host.includes(".") ||
      host.length > 253 ||
      host.split(".").some((label) => !HOST_LABEL.test(label)) ||
      host.includes(":") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|corp)$/.test(host) ||
      /(?:^|\.)home\.arpa$/.test(host)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function trackingPixel(attrs: sanitizeHtml.Attributes) {
  const style = attrs.style ?? "";
  return (
    (TINY.test(attrs.width ?? "x") && TINY.test(attrs.height ?? "x")) ||
    (TINY_STYLE_WIDTH.test(style) && TINY_STYLE_HEIGHT.test(style))
  );
}

/**
 * A CSS background image passes the same gate as an <img>: hidden (and
 * counted) unless the reader shows external images, and then only as a
 * public https URL. A "background:" shorthand carrying an image keeps its
 * colour, repeat, size and centring as separate declarations.
 */
function backgroundStyle(style: string, allowExternal: boolean, onHidden: () => void) {
  if (!/url\(/i.test(style)) return style;
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property !== "background" && property !== "background-image") {
      kept.push(declaration);
      continue;
    }
    const url = CSS_URL.exec(value);
    if (!url) {
      kept.push(declaration);
      continue;
    }
    const remote = externalImage(url[2] ?? "");
    if (remote && allowExternal) kept.push(`background-image:url("${remote}")`);
    else if (remote) onHidden();
    if (property === "background") {
      const color = CSS_COLOR.exec(value);
      if (color) kept.push(`background-color:${color[0]}`);
      if (/\bno-repeat\b/i.test(value)) kept.push("background-repeat:no-repeat");
      const size = /\b(cover|contain)\b/i.exec(value);
      if (size) kept.push(`background-size:${size[1]?.toLowerCase()}`);
      if (/\bcenter\b/i.test(value)) kept.push("background-position:center");
    }
  }
  return kept.join(";");
}

function tableCell(tagName: string) {
  return (_tag: string, attrs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
    const attribs = { ...attrs };
    if (attribs.bgcolor !== undefined && !COLOR.test(attribs.bgcolor.trim()))
      delete attribs.bgcolor;
    for (const name of ["width", "height", "border"]) {
      const value = attribs[name];
      if (value !== undefined && !LENGTH_ATTR.test(value.trim())) delete attribs[name];
    }
    return { tagName, attribs };
  };
}

/** A private projection, never a fetch/proxy. Raw MIME remains encrypted. */
export function projectMailboxHtml(
  html: string | false | undefined,
  attachments: InlineAttachment[],
  /** https URLs under this prefix (our own public storage, e.g. signature
   * logos) show at once: they reveal nothing to a third party. */
  options: { trustedImagePrefix?: string | null } = {},
) {
  if (!html) return { htmlBody: null, htmlBodyWithExternalImages: null, externalImages: 0 };
  if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  const inline = new Map<string, string>();
  for (const attachment of attachments) {
    if (!attachment.contentId || attachment.content.length > 256 * 1024) continue;
    const image = pilotImageMetadata(attachment.content);
    if (image)
      inline.set(
        contentId(attachment.contentId),
        `data:${image.contentType};base64,${attachment.content.toString("base64")}`,
      );
  }
  let externalImages = 0;
  const project = (allowExternal: boolean) => {
    // Repeated CID references must not amplify a bounded MIME body into unbounded base64 HTML.
    let inlineBudget = MAX_INLINE;
    return sanitizeHtml(html, {
      allowedTags: [
        "p",
        "div",
        "span",
        "br",
        "strong",
        "b",
        "em",
        "i",
        "u",
        "s",
        "small",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "li",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "td",
        "th",
        "hr",
        "a",
        "img",
        "pre",
        "code",
        "address",
        "center",
      ],
      allowedAttributes: {
        "*": ["style", "dir", "lang"],
        a: ["href", "title", "target", "rel"],
        img: ["src", "alt", "width", "height"],
        td: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"],
        th: ["colspan", "rowspan", "align", "valign", "width", "height", "bgcolor"],
        tr: ["align", "valign", "bgcolor"],
        table: ["cellpadding", "cellspacing", "width", "align", "border", "bgcolor"],
      },
      allowedSchemes: ["https", "http", "mailto"],
      allowedSchemesByTag: { img: ["data", "https"] },
      allowProtocolRelative: false,
      nonTextTags: ["script", "style", "textarea", "option", "svg", "math", "iframe", "object"],
      nestingLimit: 40,
      allowedStyles: {
        "*": {
          color: [COLOR],
          "background-color": [COLOR],
          // Email buttons paint their fill with the shorthand; only a plain colour passes.
          background: [COLOR],
          display: [/^(?:block|inline-block|inline|table|table-row|table-cell|none)$/],
          border: [BORDER],
          "border-radius": [SIZE],
          "font-family": [/^[\w\s,'"-]{1,160}$/],
          "font-size": [SIZE],
          "font-weight": [/^(?:normal|bold|[1-9]00)$/],
          "font-style": [/^(?:normal|italic)$/],
          "text-align": [/^(?:left|right|center|justify)$/],
          "text-decoration": [/^(?:none|underline|line-through)$/],
          "line-height": [/^(?:normal|\d(?:\.\d{1,2})?)$/, SIZE],
          "letter-spacing": [SIZE],
          "text-transform": [/^(?:none|uppercase|lowercase|capitalize)$/],
          "white-space": [/^(?:normal|nowrap)$/],
          "vertical-align": [/^(?:top|middle|bottom|baseline)$/],
          width: [SIZE],
          "max-width": [SIZE],
          "min-width": [SIZE],
          height: [SIZE],
          "min-height": [SIZE],
          padding: [PADDING],
          "padding-top": [SIZE],
          "padding-bottom": [SIZE],
          "padding-left": [SIZE],
          "padding-right": [SIZE],
          margin: [MARGIN],
          "margin-top": [MARGIN_SIDE],
          "margin-bottom": [MARGIN_SIDE],
          "margin-left": [MARGIN_SIDE],
          "margin-right": [MARGIN_SIDE],
          "border-collapse": [/^(?:collapse|separate)$/],
          // Present only in the projection that shows external images.
          "background-image": allowExternal ? [BACKGROUND_IMAGE] : [],
          "background-repeat": [/^(?:no-repeat|repeat|repeat-x|repeat-y)$/],
          "background-size": [/^(?:cover|contain|auto)$/, SIZE],
          "background-position": [
            /^(?:center|top|bottom|left|right)(?:\s+(?:center|top|bottom|left|right))?$/,
          ],
        },
      },
      transformTags: {
        // A button's fill often lives in bgcolor with white text on it: dropping the
        // fill would leave the link white on white. Only plain colours and lengths stay.
        table: tableCell("table"),
        tr: tableCell("tr"),
        td: tableCell("td"),
        th: tableCell("th"),
        a: (_tag, attrs) => ({
          tagName: "a",
          attribs: { ...attrs, target: "_blank", rel: "noopener noreferrer" },
        }),
        // Runs after the tag's own transform, on every tag.
        "*": (tagName, attrs): sanitizeHtml.Tag =>
          attrs.style
            ? {
                tagName,
                attribs: {
                  ...attrs,
                  style: backgroundStyle(attrs.style, allowExternal, () => {
                    if (!allowExternal) externalImages++;
                  }),
                },
              }
            : { tagName, attribs: attrs },
        img: (_tag, attrs): sanitizeHtml.Tag => {
          if (trackingPixel(attrs)) return { tagName: "span", attribs: {}, text: "" };
          const source = attrs.src ?? "";
          const embedded = /^cid:/i.test(source) ? inline.get(contentId(source.slice(4))) : null;
          if (embedded && embedded.length <= inlineBudget) {
            inlineBudget -= embedded.length;
            return {
              tagName: "img",
              attribs: { src: embedded, alt: attrs.alt ?? "", ...imageSize(attrs) },
            };
          }
          const remote = externalImage(source);
          if (remote) {
            const shown = { src: remote, alt: attrs.alt ?? "", ...imageSize(attrs) };
            if (options.trustedImagePrefix && remote.startsWith(options.trustedImagePrefix))
              return { tagName: "img", attribs: shown };
            if (!allowExternal) externalImages++;
            else return { tagName: "img", attribs: shown };
          }
          return attrs.alt?.trim()
            ? { tagName: "span", attribs: { style: PLACEHOLDER_STYLE }, text: attrs.alt }
            : { tagName: "span", attribs: {}, text: "" };
        },
      },
    });
  };
  const htmlBody = project(false);
  return {
    htmlBody: htmlBody.trim() ? htmlBody : null,
    htmlBodyWithExternalImages: externalImages ? project(true) : null,
    externalImages,
  };
}
