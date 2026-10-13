/**
 * Sender logos in the Correio (as Gmail shows Amazon's): which domain to ask for, and
 * only for mail that proved where it came from. A logo is shown only when the message
 * passed DMARC (so a forged "From: amazon.com" never gets Amazon's mark); a BIMI logo,
 * the brand's own published one, also needs the domain's DMARC policy to be enforced
 * (quarantine or reject), as BIMI requires. Personal mail services get no brand mark
 * (their favicon is the provider's), only the person's own Gravatar photo when there is
 * one; the photo is fetched by our server from a hash, so Gravatar never sees the reader.
 */

/** Mail services whose addresses belong to people, not to the brand of the domain. */
const PERSONAL_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.br",
  "hotmail.com",
  "hotmail.com.br",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "r7.com",
]);

/** Second-level public suffixes common in our mail (an org domain is one label more). */
const TWO_LABEL_SUFFIXES = new Set([
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  "art.br",
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "co.nz",
  "co.jp",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.uy",
  "co.za",
  "com.tr",
  "com.cn",
  "com.hk",
  "com.sg",
  "co.in",
  "co.kr",
  "com.pt",
]);

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** A hostname as the logo service takes it (lower case, no trailing dot), or null. */
export function normalizeLogoDomain(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return HOST.test(host) ? host : null;
}

/** The registrable domain: "mail.amazon.com.br" → "amazon.com.br". */
export function organizationalDomain(host: string): string {
  const labels = host.split(".");
  const keep = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export function isPersonalMailDomain(host: string): boolean {
  return PERSONAL_MAIL.has(host) || PERSONAL_MAIL.has(organizationalDomain(host));
}

/** What the server recorded about a received message's authentication. */
interface Assessment {
  verdicts?: { dmarc?: string } | null;
  dmarcPolicy?: string | null;
}

/**
 * The picture to ask for, if any: the sender's address (for a Gravatar), its domain (null
 * for personal mail services, which only get the person's Gravatar) and whether a BIMI
 * logo may be used. Null for unauthenticated mail and anything that is not received.
 */
export function senderLogoFor(row: {
  kind: string;
  from: string;
  inboundAssessment?: Assessment | null | unknown;
}): SenderPicture | null {
  if (row.kind !== "inbox") return null;
  const assessment = (row.inboundAssessment ?? null) as Assessment | null;
  if (assessment?.verdicts?.dmarc !== "PASS") return null;
  const address = row.from.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const domain = at < 1 ? null : normalizeLogoDomain(address.slice(at + 1));
  if (!domain) return null;
  const bimi = assessment.dmarcPolicy === "quarantine" || assessment.dmarcPolicy === "reject";
  return isPersonalMailDomain(domain)
    ? { address, domain: null, bimi: false }
    : { address, domain, bimi };
}

export interface SenderPicture {
  address: string;
  domain: string | null;
  bimi: boolean;
}

/** The image URL for a server-signed picture token (404 when there is nothing to show). */
export function senderPictureUrl(token: string): string {
  return `/api/mailboxes/sender-logo?t=${encodeURIComponent(token)}`;
}
