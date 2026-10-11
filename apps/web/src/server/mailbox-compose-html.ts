import sanitizeHtml from "sanitize-html";

/** The composer's formatted body, at most (the plain text part travels with it). */
export const MAILBOX_COMPOSE_HTML_MAX = 256 * 1024;

/**
 * The formatting a person writes in Mail, as it is sealed and sent: bold, italic,
 * underline, strike, links to web or mail addresses, lists, quotes and code. No styles,
 * scripts, event handlers, images, frames or forms; links open in a new context without
 * a referrer. Applied again when a draft is opened for editing.
 */
export function sanitizeMailboxComposeHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "div",
      "span",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
    ],
    allowedAttributes: { a: ["href", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...(attribs.href ? { href: attribs.href } : {}), rel: "noopener noreferrer" },
      }),
    },
  }).trim();
}
