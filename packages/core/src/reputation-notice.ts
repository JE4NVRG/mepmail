/**
 * A reputation review is a human decision, so it has to reach a human. The
 * panel warning is easy to miss and the audit row only exists for whoever
 * thinks to query it; the operator's Telegram is where incidents are actually
 * seen, and this is the same channel the signup alerts already use.
 *
 * Best effort by design: a missing token, a Telegram outage or a slow API must
 * never delay or fail the provider event that triggered it.
 */
export const REPUTATION_REVIEW_PREFIX = "sending.reputation_review";

export interface ReputationReviewNotice {
  teamId: string;
  plan: string;
  sent: number;
  hardBounced: number;
  complained: number;
  reason: string;
}

function telegramTarget(): { token: string; chatId: string; threadId: number | null } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  const raw = process.env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return { token, chatId, threadId: Number.isFinite(parsed) && parsed > 0 ? parsed : null };
}

export function reputationReviewText(notice: ReputationReviewNotice): string {
  const bounce = notice.sent > 0 ? ((notice.hardBounced / notice.sent) * 100).toFixed(1) : "0.0";
  return [
    "MepMail: conta em revisao de reputacao",
    `time ${notice.teamId} (${notice.plan})`,
    `motivo: ${notice.reason}`,
    `envios 24h: ${notice.sent}`,
    `bounces duros: ${notice.hardBounced} (${bounce}%)`,
    `reclamacoes: ${notice.complained}`,
    "segue enviando; painel em revisao",
  ].join("\n");
}

/** Never throws and never awaits the network on the caller's critical path. */
export function notifyReputationReview(notice: ReputationReviewNotice): void {
  const target = telegramTarget();
  if (!target) return;
  const body: Record<string, unknown> = {
    chat_id: target.chatId,
    text: reputationReviewText(notice),
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
