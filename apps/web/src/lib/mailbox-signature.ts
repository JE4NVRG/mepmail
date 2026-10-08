import type { schema } from "@millionsend/db";
import { escapeHtml } from "@/lib/html";
import { mailboxSignature } from "@/lib/mailbox-compose-signature";

export type MailboxSignatureProfile = schema.MailboxSignatureProfile;

/** A mailbox's signature: the structured fields and its free-text lines. */
export interface MailboxSignatureSource {
  profile: MailboxSignatureProfile | null;
  text: string;
}

const ACCENT = "#6741c5";
const LOGO_HEIGHT = 48;
const LOGO_MAX_WIDTH = 160;

/** "https://www.example.com/" reads as "www.example.com". */
export function mailboxSignatureDisplayUrl(url: string) {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function roleLine(profile: MailboxSignatureProfile | null) {
  return profile ? [profile.title, profile.company].filter(Boolean).join(" · ") : "";
}

/**
 * The plain-text signature, without the "--" delimiter: name, title and
 * company, phone and website, then the free-text lines. A mailbox with no
 * structured fields reads exactly as its free text did before.
 */
export function mailboxSignatureText(source: MailboxSignatureSource) {
  const profile = source.profile;
  const lines: string[] = [];
  if (profile) {
    if (profile.name) lines.push(profile.name);
    const role = roleLine(profile);
    if (role) lines.push(role);
    const contact = [
      profile.phone,
      profile.website ? mailboxSignatureDisplayUrl(profile.website) : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (contact) lines.push(contact);
  }
  const extra = source.text.trim();
  if (extra) lines.push(extra);
  return lines.join("\n");
}

function lines(text: string) {
  return text.split("\n").map(escapeHtml).join("<br>");
}

function logoSize(profile: MailboxSignatureProfile) {
  const { logoWidth: width, logoHeight: height } = profile;
  if (!width || !height) return { width: LOGO_HEIGHT * 2, height: null };
  let h = LOGO_HEIGHT;
  let w = Math.round((h * width) / height);
  if (w > LOGO_MAX_WIDTH) {
    w = LOGO_MAX_WIDTH;
    h = Math.round((w * height) / width);
  }
  return { width: w, height: h };
}

/**
 * The signature as email-safe HTML: one table with inline styles (what mail
 * clients keep), the logo on the left behind an accent rule, links for the
 * phone and website. Every value is escaped; an empty signature is "".
 */
export function mailboxSignatureHtml(source: MailboxSignatureSource) {
  const profile = source.profile;
  const extra = source.text.trim();
  const structured =
    !!profile &&
    !!(
      profile.name ||
      profile.title ||
      profile.company ||
      profile.phone ||
      profile.website ||
      profile.logoUrl
    );
  if (!structured)
    return extra
      ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#5f6368">${lines(extra)}</div>`
      : "";
  const role = roleLine(profile);
  const phone = profile.phone
    ? `<a href="tel:${escapeHtml(profile.phone.replace(/[^0-9+]/g, ""))}" style="color:#3c4043;text-decoration:none">${escapeHtml(profile.phone)}</a>`
    : "";
  const website = profile.website
    ? `<a href="${escapeHtml(profile.website)}" style="color:${ACCENT};text-decoration:none">${escapeHtml(mailboxSignatureDisplayUrl(profile.website))}</a>`
    : "";
  const contact = [phone, website].filter(Boolean).join(' <span style="color:#bdc1c6">·</span> ');
  let logo = "";
  if (profile.logoUrl) {
    const size = logoSize(profile);
    logo = `<td style="padding:0 14px 0 0;vertical-align:middle"><img src="${escapeHtml(profile.logoUrl)}" alt="${escapeHtml(profile.company || profile.name)}" width="${size.width}"${size.height ? ` height="${size.height}"` : ""} style="display:block;border:0;outline:none;width:${size.width}px;max-width:${size.width}px;height:auto"></td>`;
  }
  const details = [
    profile.name
      ? `<div style="font-size:14px;font-weight:bold;color:#202124">${escapeHtml(profile.name)}</div>`
      : "",
    role ? `<div style="color:#5f6368">${escapeHtml(role)}</div>` : "",
    contact ? `<div style="padding-top:4px">${contact}</div>` : "",
    extra ? `<div style="padding-top:4px;color:#5f6368">${lines(extra)}</div>` : "",
  ].join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#3c4043"><tr>${logo}<td style="vertical-align:middle;padding:0 0 0 12px;border-left:2px solid ${ACCENT}">${details}</td></tr></table>`;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/gi;

function linked(line: string) {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    const url = match[0];
    const at = match.index ?? 0;
    out += escapeHtml(line.slice(last, at));
    out += `<a href="${escapeHtml(url)}" style="color:${ACCENT}">${escapeHtml(url)}</a>`;
    last = at + url.length;
  }
  return out + escapeHtml(line.slice(last));
}

/**
 * Typed text as HTML: paragraphs at blank lines, line breaks kept, links
 * made clickable, "> " quoted lines as a quote block. Everything is escaped.
 */
export function mailboxTextToHtml(text: string): string {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] ?? "";
    if (row.startsWith(">")) {
      const quoted: string[] = [];
      while (i < rows.length && (rows[i] ?? "").startsWith(">"))
        quoted.push((rows[i++] ?? "").replace(/^> ?/, ""));
      out.push(
        `<blockquote style="margin:0 0 12px 4px;padding:0 0 0 12px;border-left:2px solid #dadce0;color:#5f6368">${mailboxTextToHtml(quoted.join("\n"))}</blockquote>`,
      );
      continue;
    }
    if (!row.trim()) {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < rows.length && (rows[i] ?? "").trim() && !(rows[i] ?? "").startsWith(">"))
      paragraph.push(linked(rows[i++] ?? ""));
    out.push(`<p style="margin:0 0 12px">${paragraph.join("<br>")}</p>`);
  }
  return out.join("");
}

/**
 * The HTML part of a Correio message. Where the text carries the mailbox's
 * managed signature footer (as the composer inserts it), that footer becomes
 * the formatted signature; a footer the author edited stays plain text.
 */
export function mailboxDraftHtml(text: string, source: MailboxSignatureSource) {
  const footer = mailboxSignature(mailboxSignatureText(source));
  const at = footer ? text.lastIndexOf(footer) : -1;
  const body =
    at === -1
      ? mailboxTextToHtml(text)
      : `${mailboxTextToHtml(text.slice(0, at))}<div style="margin:20px 0 12px">${mailboxSignatureHtml(source)}</div>${mailboxTextToHtml(text.slice(at + footer.length))}`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#202124">${body}</div>`;
}
