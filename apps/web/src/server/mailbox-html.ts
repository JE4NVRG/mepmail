import sanitizeHtml from "sanitize-html";
import { pilotImageMetadata } from "../../../../packages/core/src/mailbox-pilot-images";

type InlineAttachment = { contentId?: string | undefined; content: Buffer };
const MAX_HTML = 1024 * 1024;
const HOST_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const SIZE = /^(?:\d{1,3}(?:\.\d{1,2})?)(?:px|em|rem|%)$/;
const COLOR = /^(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\))$/i;
/** Table attributes keep only plain values: a colour or a length, never a URL. */
const LENGTH_ATTR = /^\d{1,4}%?$/;
const BORDER =
  /^(?:0|none|\d{1,2}px(?:\s+(?:solid|dashed|dotted|none))?(?:\s+(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d\s.,%]+\)))?)$/i;

function contentId(value: string) {
  return value.trim().replace(/^<|>$/g, "");
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
) {
  if (!html || html.length > MAX_HTML)
    return { htmlBody: null, htmlBodyWithExternalImages: null, externalImages: 0 };
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
    let inlineBudget = MAX_HTML;
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
          "line-height": [/^(?:normal|\d(?:\.\d{1,2})?)$/],
          "vertical-align": [/^(?:top|middle|bottom|baseline)$/],
          width: [SIZE],
          "max-width": [SIZE],
          height: [SIZE],
          padding: [SIZE],
          "padding-top": [SIZE],
          "padding-bottom": [SIZE],
          "padding-left": [SIZE],
          "padding-right": [SIZE],
          margin: [SIZE],
          "margin-top": [SIZE],
          "margin-bottom": [SIZE],
          "margin-left": [SIZE],
          "margin-right": [SIZE],
          "border-collapse": [/^(?:collapse|separate)$/],
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
        img: (_tag, attrs): sanitizeHtml.Tag => {
          const source = attrs.src ?? "";
          const embedded = /^cid:/i.test(source) ? inline.get(contentId(source.slice(4))) : null;
          if (embedded && embedded.length <= inlineBudget) {
            inlineBudget -= embedded.length;
            return { tagName: "img", attribs: { src: embedded, alt: attrs.alt ?? "" } };
          }
          const remote = externalImage(source);
          if (remote) {
            if (!allowExternal) externalImages++;
            if (allowExternal)
              return { tagName: "img", attribs: { src: remote, alt: attrs.alt ?? "" } };
          }
          return { tagName: "span", attribs: {}, text: attrs.alt ?? "" };
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
