import { MAIL_LOCALES, type MailLocale } from "@millionsend/core";
import { escapeHtml, fillTemplate } from "@millionsend/core/html";
import en from "../../messages/en/onboarding-email.json";
import ptBR from "../../messages/pt-BR/onboarding-email.json";

const MESSAGES = { en, "pt-BR": ptBR } as const;

export { MAIL_LOCALES, type MailLocale };

/** Product home, as a text link: no author image survives the dispatch projection. */
const HOME_URL = "https://mepmail.dev/";

/**
 * The pre-dispatch projection holds any anchor it cannot re-verify, and a
 * single unverifiable anchor makes the whole message uninspectable, so a
 * dashboard base that is not a plain HTTP(S) URL without credentials drops the
 * button instead of poisoning the body.
 */
function dashboardHref(value: string | null): string | null {
  if (!value || !/^https?:\/\/[^\s<>"'\\]+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password) return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * The onboarding "Send email" body in the dashboard's locale: the first
 * email a team ever sends through the instance. Exported for tests;
 * interpolates and escapes, so strings stay in JSON.
 *
 * The markup is deliberately the small set the dispatch projection
 * recognizes (tags, inline declarations, one link per URL): an image, a
 * comment or an unknown attribute makes the message uninspectable, and the
 * content judge is then never asked about it.
 */
export function buildOnboardingEmail(input: {
  locale: MailLocale;
  team: string;
  dashboardUrl: string | null;
}): { subject: string; html: string; text: string } {
  const m = MESSAGES[input.locale];
  const href = dashboardHref(input.dashboardUrl);
  const footer = fillTemplate(m.footer, { team: input.team });
  const button = href
    ? `<p style="margin:0"><a class="ms-btn" href="${escapeHtml(href)}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;padding:12px 20px">${escapeHtml(m.button)}</a></p>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(input.locale)}">
<head>
<title>${escapeHtml(m.subject)}</title>
</head>
<body>
<div class="ms-page" style="background-color:#f4f4f5;padding:32px 16px;font-family:arial,sans-serif">
<div class="ms-card" style="background-color:#ffffff;padding:32px;border-radius:8px">
<p class="ms-text" style="font-size:13px;line-height:1.5;margin:0 0 24px"><a class="ms-link" href="${HOME_URL}" style="color:#18181b;font-weight:700;text-decoration:none">MepMail</a></p>
<p class="ms-text" style="font-size:22px;line-height:1.3;font-weight:700;color:#18181b;margin:0 0 12px">${escapeHtml(m.heading)}</p>
<p class="ms-text" style="font-size:14px;line-height:1.5;color:#18181b;margin:0 0 12px">${escapeHtml(m.body)}</p>
${button}
<p class="ms-muted" style="font-size:13px;line-height:1.5;color:#52525b;margin:24px 0 0">${escapeHtml(footer)}</p>
</div>
</div>
</body>
</html>`;
  const text = [m.heading, m.body, ...(href ? [`${m.button}: ${href}`] : []), footer].join("\n\n");
  return { subject: m.subject, html, text };
}
