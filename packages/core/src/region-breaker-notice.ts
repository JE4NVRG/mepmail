/**
 * A reputation pause is a human decision, so it has to reach a human. The panel
 * banner is easy to miss on a phone and the audit row only exists for whoever
 * thinks to query it; the operator's Telegram is where incidents are actually
 * seen, and this is the same channel the signup and reputation alerts use.
 *
 * Best effort by design: a missing token, a Telegram outage or a slow API must
 * never delay or fail the breaker run that triggered it.
 */
export const REGION_BREAKER_PREFIX = "sending.region_breaker";

export interface TenantPauseNotice {
  region: string;
  teamId: string;
  teamName: string;
  metric: "bounce" | "complaint";
  events: number;
  sent: number;
  windowHours: number;
  /** first-party keeps transactional mail; a third party loses every surface. */
  kind?: "broadcast_only" | "broadcast_only_urgent" | "full_review";
}

export interface RegionHoldNotice {
  region: string;
  metric: "bounce" | "complaint";
  rate: number;
  limit: number;
  sent: number;
  events: number;
  windowHours: number;
}

export interface RegionDeferredNotice {
  region: string;
  teams: number;
}

function rate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** No URLs, tokens or recipients: the operator only needs who stopped and why. */
export function tenantPauseText(n: TenantPauseNotice): string {
  return [
    n.kind === "broadcast_only_urgent"
      ? "MepMail: URGENTE - reincidencia em 24h"
      : "MepMail: time pausado antes da regiao",
    `regiao ${n.region} · ${n.metric === "complaint" ? "reclamacao" : "bounce duro"}`,
    `time ${n.teamName} (${n.teamId})`,
    `eventos ${n.events} em ${n.sent} envios (${n.windowHours}h)`,
    n.kind === "full_review"
      ? "envio do time retido para revisao (todas as superficies)"
      : n.kind === "broadcast_only_urgent"
        ? "broadcasts pausados de novo em 24h; transacional segue por decisao explicita"
        : "broadcasts do time pausados; transacional e first-party seguem",
  ].join("\n");
}

export function regionHoldText(n: RegionHoldNotice): string {
  return [
    "MepMail: broadcasts pausados na regiao",
    `regiao ${n.region} · ${n.metric === "complaint" ? "reclamacao" : "bounce duro"}`,
    `taxa ${rate(n.rate)} (limite ${rate(n.limit)}) em ${n.sent} envios · ${n.events} eventos`,
    `janela ${n.windowHours}h · a taxa continua acima do limite sem os times ja pausados`,
    "transacional e first-party seguem enviando",
  ].join("\n");
}

export function regionDeferredText(n: RegionDeferredNotice): string {
  return [
    "MepMail: regiao liberada, pausa ficou no time",
    `regiao ${n.region}`,
    `${n.teams} time(s) com envio retido; a taxa da regiao normalizou sem eles`,
  ].join("\n");
}

function telegramTarget(): { token: string; chatId: string; threadId: number | null } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  const raw = process.env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return { token, chatId, threadId: Number.isFinite(parsed) && parsed > 0 ? parsed : null };
}

/** Never throws and never awaits the network on the caller's critical path. */
export function notifyRegionBreaker(text: string): void {
  const target = telegramTarget();
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
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}
