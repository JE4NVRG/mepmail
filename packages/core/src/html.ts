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
 * Wordmarks for system emails, hosted by the product site rather than the
 * instance: most self-hosted deployments sit on private or loopback hosts
 * that recipients' mail clients cannot fetch from. Ink glyphs for the light
 * card, bone glyphs for a dark one, both on a transparent ground and wide
 * enough that Gmail for Android, which recolours images drawn at 64×64 CSS px
 * or smaller, leaves them alone.
 */
export const EMAIL_WORDMARK_INK_URL = "https://millionsend.com/email/wordmark-ink.png";
export const EMAIL_WORDMARK_BONE_URL = "https://millionsend.com/email/wordmark-bone.png";

/**
 * Fills `{key}` placeholders. A replacer function, not a replacement string:
 * user-controlled values such as names may contain `$'` / `$$`, which
 * String.replace would otherwise interpret. Every occurrence is filled.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const MUTED =
  'class="ms-muted" style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0"';

/** The dark theme, in the dashboard's tokens: void, panel, bone, muted; the button flips to bone on ink. */
const DARK_RULES = [
  ".ms-page{background:#0a0a0a!important}",
  ".ms-card{background:#0c0c0d!important}",
  ".ms-text{color:#f4f1ea!important}",
  ".ms-muted{color:#918f89!important}",
  ".ms-link{color:#f4f1ea!important}",
  ".ms-btn{background:#f4f1ea!important;color:#0c0c0d!important}",
  ".ms-ink{display:none!important}",
  ".ms-bone{display:block!important}",
];

/**
 * Mail clients go dark in three ways, and the sheet answers each. Apple Mail,
 * iOS Mail, Outlook for Mac, Samsung and Thunderbird honour the media query
 * once the color-scheme meta opts the email in. Outlook.com and the Outlook
 * apps recolour on their own and stamp data-ogsc / data-ogsb on what they
 * touched, so the same rules hang off those. Gmail with a Google account
 * honours neither: it only repaints the card (Android darkens light
 * backgrounds and keeps dark ones, iOS inverts every colour) and wraps the
 * body so that `u + .body` matches there alone. There the wordmark and the
 * button are painted as the difference from the card instead: the bone
 * glyphs and a white fill come out ink on the light card and bone on a dark
 * one, and the button's label sits in nested black wrappers that keep it
 * white in the button's own layer whatever Gmail does to colours, so the
 * label reads as the fill's negative. Gmail leaves gradients and images as
 * they are, which is why the fills are gradients.
 */
const STYLE = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark}",
  `@media (prefers-color-scheme:dark){${DARK_RULES.join("")}}`,
  ...DARK_RULES.flatMap((rule) => [`[data-ogsc] ${rule}`, `[data-ogsb] ${rule}`]),
  "u + .body .ms-ink{display:none!important}",
  "u + .body .ms-bone{display:block!important}",
  "u + .body .ms-btn{display:none!important}",
  "u + .body .ms-gmail{display:inline-block!important}",
].join("\n");

const WORDMARK = `<a href="https://millionsend.com" style="display:block;margin:0 0 24px;line-height:0">
      <img class="ms-ink" src="${EMAIL_WORDMARK_INK_URL}" width="174" height="24" alt="MillionSend" style="display:block;height:24px;width:auto;border:0">
      <img class="ms-bone" src="${EMAIL_WORDMARK_BONE_URL}" width="174" height="24" alt="MillionSend" style="display:none;mso-hide:all;height:24px;width:auto;border:0;mix-blend-mode:difference">
    </a>`;

function buttons(url: string, label: string): string {
  const text = `font-size:14px;font-weight:600`;
  return `<a class="ms-btn" href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;${text};text-decoration:none;border-radius:8px;padding:12px 20px;margin-top:12px">${label}</a>
    <a class="ms-gmail" href="${url}" style="display:none;mso-hide:all;background:linear-gradient(#ffffff,#ffffff);mix-blend-mode:difference;border-radius:8px;margin-top:12px;text-decoration:none"><span style="display:inline-block;background:linear-gradient(#000000,#000000);mix-blend-mode:difference;border-radius:8px;padding:12px 20px"><span style="background:#000000;mix-blend-mode:screen"><span style="background:#000000;mix-blend-mode:difference"><span style="color:#ffffff;${text}">${label}</span></span></span></span></a>`;
}

/**
 * The one account-mail layout, for every email the instance sends about
 * itself: wordmark, card, an optional heading, paragraphs, a button, then
 * muted footers, as a full document so the theme sheet reaches the clients
 * that read one. The card is the dashboard's light panel tone rather than
 * pure white, which Apple Mail may invert on its own. `linkFallback` adds
 * the button's URL as text under it, for the mails whose link is the point
 * (a reset, a verification); without it the text version names the button
 * instead. Everything is escaped here, so catalogs stay plain text.
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
    ? `<p class="ms-text" style="font-size:22px;line-height:1.3;font-weight:700;color:#18181b;margin:0 0 12px;font-variant-numeric:tabular-nums">${escapeHtml(input.heading)}</p>\n    `
    : "";
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p class="ms-text" style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(p)}</p>`,
    )
    .join("\n    ");
  const button =
    url !== undefined && input.button ? `\n    ${buttons(url, escapeHtml(input.button))}` : "";
  const fallback =
    url !== undefined && input.linkFallback
      ? `\n    <p ${MUTED}>${escapeHtml(input.linkFallback)}<br><a class="ms-link" href="${url}" style="color:#18181b;word-break:break-all">${url}</a></p>`
      : "";
  const muted = input.muted.map((m) => `<p ${MUTED}>${escapeHtml(m)}</p>`).join("\n    ");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
${STYLE}
</style>
</head>
<body class="body" style="margin:0;padding:0">
<div class="ms-page" style="background:#f4f4f5;padding:32px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div class="ms-card" style="max-width:440px;margin:0 auto;background:#fffefb;border-radius:12px;padding:32px">
    ${WORDMARK}
    ${heading}${paragraphs}${button}${fallback}
    ${muted}
  </div>
</div>
</body>
</html>`;
  const link =
    input.url === undefined ? "" : input.linkFallback ? input.url : `${input.button}: ${input.url}`;
  const lines = input.heading ? [input.heading, ...input.paragraphs] : input.paragraphs;
  const text = `${lines.join("\n\n")}\n\n${link}\n\n${input.muted.join("\n\n")}\n`;
  return { html, text };
}
