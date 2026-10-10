import { z } from "zod";

/**
 * Respostas rápidas: short replies that one click puts at the top of a reply.
 * They live in the person's Correio preferences (plain text the person writes,
 * like a signature), so they stay short: that object has a 4 KiB ceiling
 * shared with every other field. `null` means the built-in, translated set.
 */
export const QUICK_REPLY_LIMITS = { count: 8, chars: 160, bytes: 2048 } as const;

const encoder = new TextEncoder();

export const quickRepliesSchema = z.union([
  z.null(),
  z
    .array(z.string().trim().min(1).max(QUICK_REPLY_LIMITS.chars))
    .max(QUICK_REPLY_LIMITS.count)
    .refine((list) => encoder.encode(JSON.stringify(list)).length <= QUICK_REPLY_LIMITS.bytes),
]);

/** How long Send waits for "Desfazer" before the message reaches the server. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];

export const undoSendSchema = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(10),
  z.literal(20),
  z.literal(30),
]);

/**
 * The list being edited, cleaned the way the server will store it: trimmed,
 * empty lines dropped, duplicates removed, cut to the limits. Null when the
 * result would not fit (the editor then says so instead of saving).
 */
export function cleanQuickReplies(list: readonly string[]): string[] | null {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    if (value.length > QUICK_REPLY_LIMITS.chars) return null;
    seen.add(value);
    result.push(value);
  }
  if (result.length > QUICK_REPLY_LIMITS.count) return null;
  return quickRepliesSchema.safeParse(result).success ? result : null;
}

/**
 * A reply's starting text with the quick reply on top. The reply body starts
 * with a blank line before the signature or the quote, so the reply sits in
 * its own paragraph and the cursor can go right after it.
 */
export function withQuickReply(body: string, reply: string): string {
  const value = reply.trim();
  if (!value) return body;
  return body.startsWith("\n") ? `${value}${body}` : `${value}\n\n${body}`;
}
