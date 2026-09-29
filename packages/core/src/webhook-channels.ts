/**
 * Channel formatting for webhook deliveries: when an endpoint's URL points at
 * a well-known chat service, the event is POSTed in that service's expected
 * shape instead of the raw JSON envelope. Detection is URL-based on purpose —
 * no schema flag to migrate, and pasting a Slack / Discord / Telegram webhook
 * URL is the whole setup. Anything unrecognized keeps the raw signed JSON
 * body (the Svix-style signing headers ride along either way; chat services
 * ignore unknown headers).
 */
import type { WebhookPayload } from "./webhooks.js";

export type WebhookChannel = "slack" | "discord" | "telegram";

/**
 * Well-known chat endpoints. Telegram needs its chat id: users paste the
 * sendMessage URL with `?chat_id=<id|@channel>` (the bot token rides in the
 * path, exactly as BotFather reports it).
 */
export function detectWebhookChannel(url: string): WebhookChannel | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (host === "hooks.slack.com") return "slack";
  if (
    (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) &&
    path.startsWith("/api/webhooks/")
  ) {
    return "discord";
  }
  if (host === "api.telegram.org" && /^\/bot[^/]+\/sendmessage$/.test(path)) {
    return "telegram";
  }
  return null;
}

/** The human line(s) every channel body is built from. */
function textFields(payload: WebhookPayload): { title: string; lines: string[] } {
  const data = payload.data ?? {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const title = `MepMail · ${payload.type}`;
  const lines: string[] = [];
  const subject = str(data.subject);
  if (subject) lines.push(`Subject: ${subject}`);
  const toRaw = data.to;
  const to = Array.isArray(toRaw)
    ? toRaw.filter((x) => typeof x === "string").join(", ")
    : str(toRaw);
  if (to) lines.push(`To: ${to}`);
  const from = str(data.from);
  if (from) lines.push(`From: ${from}`);
  const id = str(data.email_id);
  if (id) lines.push(`ID: ${id}`);
  lines.push(`At: ${payload.created_at}`);
  return { title, lines };
}

/**
 * The body to POST for this endpoint, or null to keep the raw JSON envelope.
 */
export function formatChannelPayload(
  url: string,
  payload: WebhookPayload,
): Record<string, unknown> | null {
  const channel = detectWebhookChannel(url);
  if (!channel) return null;
  const { title, lines } = textFields(payload);
  if (channel === "slack") {
    return { text: `${title}\n${lines.join("\n")}` };
  }
  if (channel === "discord") {
    // Markdown: bold title, block-quoted detail lines.
    return { content: `**${title}**\n${lines.map((line) => `> ${line}`).join("\n")}` };
  }
  // telegram — chat id from the stored URL's query string (?chat_id=…).
  let chatId: string | null = null;
  try {
    chatId = new URL(url).searchParams.get("chat_id");
  } catch {
    chatId = null;
  }
  if (!chatId) return null;
  return {
    chat_id: chatId,
    text: `${title}\n${lines.join("\n")}`,
    disable_web_page_preview: true,
  };
}
