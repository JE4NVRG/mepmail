/** Escape a string for safe interpolation into HTML text or a "-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Inverse of escapeHtml, plus the numeric references other escapers emit
 * (Handlebars writes `=` as `&#x3D;`, React `'` as `&#x27;`). Ampersand
 * last so `&amp;lt;` decodes to the literal `&lt;`, not `<`.
 */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * Wordmark for system emails, hosted by the product site rather than the
 * instance: most self-hosted deployments sit on private or loopback hosts
 * that recipients' mail clients cannot fetch from. Bone glyphs on an ink
 * plate, baked into the PNG: dark-theme mail clients repaint the card's
 * colours (Gmail for Android darkens light backgrounds, Gmail for iOS inverts
 * everything) but never an image's pixels, so the plate keeps the wordmark
 * legible on the white card and on whatever the card becomes. Rendered at
 * 4× its 198×40 display size; Gmail for Android recolours images under
 * about 100px of intrinsic height.
 */
export const EMAIL_WORDMARK_URL = "https://millionsend.com/email/wordmark-badge.png";

/**
 * Fills `{key}` placeholders. A replacer function, not a replacement string:
 * user-controlled values such as names may contain `$'` / `$$`, which
 * String.replace would otherwise interpret. Every occurrence is filled.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const MUTED = 'style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0"';

/**
 * The one account-mail layout, for every email the instance sends about
 * itself: wordmark, white card, an optional heading, paragraphs, a button,
 * then muted footers. The button is steel rather than ink: Gmail for
 * Android darkens the white card but leaves a near-black background as it
 * is, so an ink button vanishes there, while a mid-tone keeps its contrast
 * against the card and its text through partial and full inversion alike.
 * `linkFallback` adds the button's URL as text under it, for the mails whose
 * link is the point (a reset, a verification); without it the text version
 * names the button instead. Everything is escaped here, so catalogs stay
 * plain text.
 */
export function accountMailCard(input: {
  heading?: string;
  paragraphs: string[];
  button?: string;
  url?: string | undefined;
  linkFallback?: string;
  muted: string[];
}): { html: string; text: string } {
  const url = input.url === undefined ? undefined : escapeHtml(input.url);
  const heading = input.heading
    ? `<p style="font-size:22px;line-height:1.3;font-weight:700;color:#18181b;margin:0 0 12px;font-variant-numeric:tabular-nums">${escapeHtml(input.heading)}</p>\n    `
    : "";
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(p)}</p>`,
    )
    .join("\n    ");
  const button =
    url !== undefined && input.button
      ? `\n    <a href="${url}" style="display:inline-block;background:#59616b;color:#f4f1ea;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px;margin-top:12px">${escapeHtml(input.button)}</a>`
      : "";
  const fallback =
    url !== undefined && input.linkFallback
      ? `\n    <p ${MUTED}>${escapeHtml(input.linkFallback)}<br><a href="${url}" style="color:#18181b;word-break:break-all">${url}</a></p>`
      : "";
  const muted = input.muted.map((m) => `<p ${MUTED}>${escapeHtml(m)}</p>`).join("\n    ");
  const html = `<div style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <img src="${EMAIL_WORDMARK_URL}" width="198" height="40" alt="MillionSend" style="display:block;height:40px;width:auto;margin:0 0 24px;border:0">
    ${heading}${paragraphs}${button}${fallback}
    ${muted}
  </div>
</div>`;
  const link =
    input.url === undefined ? "" : input.linkFallback ? input.url : `${input.button}: ${input.url}`;
  const lines = input.heading ? [input.heading, ...input.paragraphs] : input.paragraphs;
  const text = `${lines.join("\n\n")}\n\n${link}\n\n${input.muted.join("\n\n")}\n`;
  return { html, text };
}
