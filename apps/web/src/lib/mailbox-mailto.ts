/**
 * `mailto:` links (RFC 6068) opened in the Correio: from a browser that chose
 * MepMail for email links, from the desktop app set as the default mail app,
 * or from a link inside a message. The link only fills the composer; nothing
 * is sent until the person sends it.
 */

export type MailtoPrefill = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
};

/** Longer links are refused rather than cut (a cut body would mislead). */
const MAX_LINK = 16_000;
const MAX_RECIPIENTS = 20;
const ADDRESS = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

function decode(value: string): string {
  try {
    // RFC 6068: spaces are %20; a "+" is a plus sign, not a space.
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addresses(value: string): string[] {
  return decode(value)
    .split(/[,;]/)
    .map((address) => address.trim().replace(/^<|>$/g, ""))
    .filter((address) => ADDRESS.test(address));
}

const unique = (list: string[]) => {
  const seen = new Set<string>();
  return list.filter((address) => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The composer fields a `mailto:` link asks for, or null when it is not one. */
export function parseMailto(raw: string): MailtoPrefill | null {
  const link = raw.trim();
  if (!/^mailto:/i.test(link) || link.length > MAX_LINK) return null;
  const rest = link.slice("mailto:".length);
  const [path = "", query = ""] = rest.split(/\?(.*)/s);
  const prefill: MailtoPrefill = { to: addresses(path), cc: [], bcc: [], subject: "", body: "" };
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const key = decode(at < 0 ? pair : pair.slice(0, at)).toLowerCase();
    const value = at < 0 ? "" : pair.slice(at + 1);
    if (key === "to") prefill.to.push(...addresses(value));
    else if (key === "cc") prefill.cc.push(...addresses(value));
    else if (key === "bcc") prefill.bcc.push(...addresses(value));
    else if (key === "subject")
      prefill.subject = decode(value)
        .replace(/[\r\n]+/g, " ")
        .slice(0, 998);
    else if (key === "body") prefill.body = decode(value).replace(/\r\n?/g, "\n");
  }
  prefill.to = unique(prefill.to).slice(0, MAX_RECIPIENTS);
  prefill.cc = unique(prefill.cc).slice(0, MAX_RECIPIENTS);
  prefill.bcc = unique(prefill.bcc).slice(0, MAX_RECIPIENTS);
  return prefill;
}

/** The Correio address that opens a `mailto:` link: /mail?mailto=<link>. */
export const MAILTO_PARAM = "mailto";

/**
 * Asks the browser to open email links in the Correio. Only some browsers
 * offer it (Chrome, Edge, Firefox), and only over https on this site; the
 * browser asks the person to confirm.
 */
export function canOfferMailtoHandler(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.registerProtocolHandler === "function" &&
    typeof window !== "undefined" &&
    window.location.protocol === "https:"
  );
}

export function registerMailtoHandler(): boolean {
  try {
    navigator.registerProtocolHandler(
      "mailto",
      `${window.location.origin}/mail?${MAILTO_PARAM}=%s`,
    );
    return true;
  } catch {
    return false;
  }
}
