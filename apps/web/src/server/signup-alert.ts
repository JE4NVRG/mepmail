import {
  notificationsEmailFrom,
  operatorAlertsSink,
  signupAlertEmail,
  telegramSignupAlert,
} from "@millionsend/config";
import { recordOperatorAlert, type SignupAttribution } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { defaultSystemMailDeps, type SystemMailDeps, sendAccountMail } from "./system-mail";

/**
 * One Telegram message per new account, so the operator learns about a sign-up
 * when it happens instead of when someone mentions it — and learns the channel
 * it arrived on, which is the whole point of the attribution cookie the proxy
 * writes (source, campaign, utm_content).
 *
 * Opt-in and best-effort by design: with no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
 * configured nothing is sent (a self-host has no chat to notify), and every
 * failure — an unreachable Bot API, a revoked token, a wrong chat id — is
 * logged and dropped. An alert may never fail the sign-up it reports.
 * SIGNUP_ALERT_EMAIL sends the same text by e-mail to an operator mailbox,
 * on its own: either channel works without the other. OPERATOR_ALERTS_SINK
 * =audit replaces that e-mail with one operator.alert audit row (the Telegram
 * post is not mail and keeps its own route).
 */

/**
 * utm_content the campaign links carry → where the link was published. The
 * mapping is the operator's, not the product's: one row per community a link
 * was posted in, so the alert names the group instead of a slug, and a slug
 * that is not here still shows up (raw) rather than being dropped.
 */
export const CAMPAIGN_SLUGS: Record<string, string> = {
  "saas-brasil": "SAAS Brasil",
  "micro-saas-brasil": "Micro SAAS Brasil",
  "desenvolvimento-de-softwares": "Desenvolvimento de Softwares (Linguagens de Programacao)",
  "devs-programadores-devops-br": "Desenvolvedores & Programadores (Web, Mobile, Games), Devops BR",
  "desenvolvedores-brasil": "Desenvolvedores Brasil",
  "react-brasil": "React Brasil",
  "python-brasil-devs": "Python Brasil Desenvolvedores",
  "programadores-python": "Programadores Python",
  "no-code-brasil": "No-Code Brasil | FlutterFlow | Bubble",
  "empreendedorismo-br": "Empreendedorismo",
  "buildinpublic-saas-founders": "#BuildInPublic | SaaS Founders | Solo Developers",
  "saas-startups-founders-network": "SaaS Startups and Founders Network",
  "saas-founders": "SaaS Founders",
  "build-in-public": "Build In Public",
  "nodejs-developers": "NodeJS Developers",
  "devops-professionals": "DevOps Professionals",
  "web-developer": "Web Developer",
  "startups-founders-investors": "Startups Founders and investors (international)",
  "startup-group-saas": "Startup group SaaS: Online Software & Services",
  "saas-growth-scale": "SaaS Growth & Scale - Founders & Agency Owners",
  "promote-your-saas-tool": "Promote Your SaaS Tool, SaaS Products",
  "saas-agency-owners": "SaaS & Agency Owners' Community",
  "email-marketing-tips": "Email Marketing Tips",
  "startup-founders-usa": "Startup Founders USA",
  "saas-marketing-group": "SaaS Marketing Group",
  "new-startup-business": "New Startup Business",
  "b2b-leadgen-email-finder": "B2B Lead generation & Email finder",
  "growth-hacking-skills": "Growth Hacking Skills [AI, SEO, Digital]",
  "growth-hacking-intl": "Growth hacking",
  "nodejs-brazil": "Node.js - Brazil",
};

/** How long the Bot API call may take before it is abandoned. */
export const SIGNUP_ALERT_TIMEOUT_MS = 3_000;

/** The moment as the operator reads it: Sao Paulo wall clock, short. */
export function alertTimestamp(now: Date): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "?";
  return `${at("day")}/${at("month")}/${at("year")} ${at("hour")}:${at("minute")} (BRT)`;
}

/**
 * The channel line: the network, and — when the campaign carried a utm_content
 * we know — the community the link was posted in. An account with no cookie at
 * all says so plainly instead of borrowing a channel it may not have had.
 */
export function originLabel(attribution: SignupAttribution | null): string {
  if (!attribution) return "sem cookie de atribuicao (direto, ou cookie expirado)";
  const network = attribution.source;
  const group = attribution.content ? CAMPAIGN_SLUGS[attribution.content] : undefined;
  const parts = [network];
  if (group) parts.push(`grupo "${group}"`);
  else if (attribution.content) parts.push(`utm_content=${attribution.content}`);
  if (attribution.referrer && attribution.referrer !== network)
    parts.push(`via ${attribution.referrer}`);
  return parts.join(" · ");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** The message body, pure so it can be asserted in tests. */
export function signupAlertMessage(params: {
  email: string;
  name?: string | null;
  attribution: SignupAttribution | null;
  locale: string;
  now?: Date;
}): string {
  const { email, name, attribution, locale } = params;
  const lines = [
    "🆕 MepMail — novo cadastro",
    "",
    `📧 ${email}`,
    `👤 ${name && name.trim() !== "" ? name : "(sem nome)"}`,
    `🎯 Origem: ${originLabel(attribution)}`,
    `📣 Campanha: ${attribution?.campaign ?? "—"}`,
    `🧭 Meio: ${attribution?.medium ?? "—"} · landing: ${attribution?.landingPath ?? "—"}`,
    `🧩 Conteúdo: ${attribution?.content ?? "—"} · termo: ${attribution?.term ?? "—"}`,
    `🔗 Referrer: ${attribution?.referrer ?? "—"}`,
    `🌎 Locale: ${locale} · moeda/idioma do convite`,
    `🕐 ${alertTimestamp(params.now ?? new Date())}`,
  ];
  return lines.join("\n");
}

/**
 * Sends the alert, if the instance is configured for alerts, and returns
 * immediately: the caller is a sign-up and must not wait on a chat API.
 * With OPERATOR_ALERTS_SINK=audit the e-mail becomes one operator.alert row
 * and `db` is required to write it.
 */
export function notifySignupAlert(
  user: { email: string; name?: string | null },
  attribution: SignupAttribution | null,
  locale: string,
  mail: SystemMailDeps = defaultSystemMailDeps,
  db?: Db,
): void {
  const target = telegramSignupAlert();
  const mailTo = signupAlertEmail();
  const from = notificationsEmailFrom();
  const sink = operatorAlertsSink();
  if (!target && sink !== "audit" && !(mailTo && from)) return;
  const subject = `MepMail: novo cadastro ${user.email}`;
  const text = signupAlertMessage({
    email: user.email,
    name: user.name ?? null,
    attribution,
    locale,
  });
  if (sink === "audit") {
    // One audit row the relay posts, with the subject and body the e-mail
    // would have carried; the alert has no link, so the url stays empty.
    if (!db) {
      console.error(
        "signup alert: OPERATOR_ALERTS_SINK=audit without a database, alert not recorded",
      );
    } else {
      void recordOperatorAlert(db, {
        kind: "signup.alert",
        subject,
        text,
        url: "",
        teamId: null,
      });
    }
  } else if (mailTo && from) {
    sendAccountMail(
      {
        from,
        to: mailTo,
        subject,
        text,
        html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        kind: "signup.alert",
      },
      mail,
    );
  }
  if (!target) return;
  const body: Record<string, unknown> = {
    chat_id: target.chatId,
    text,
    disable_web_page_preview: true,
  };
  if (target.threadId !== null) body.message_thread_id = target.threadId;
  void fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SIGNUP_ALERT_TIMEOUT_MS),
  })
    .then(async (response) => {
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error("signup alert rejected", response.status, detail.slice(0, 300));
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        result?: { message_id?: number };
      } | null;
      console.info("signup alert sent", `message_id=${payload?.result?.message_id ?? "?"}`);
    })
    .catch((error) => console.error("signup alert failed", error));
}
