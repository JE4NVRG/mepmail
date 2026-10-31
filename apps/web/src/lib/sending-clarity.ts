/** Presentation only: no authorization or operator policy is sent to the browser. */
export const sendingClarityEnglish = {
  "sendingPaused.scopeText":
    "Sending for this team is temporarily unavailable. Pending messages are not confirmation of delivery; check their status and any release requirements.",
  "sendingPaused.limitedText":
    "Sending is limited to this team’s enabled routes and senders. Check each message for delivery confirmation.",
  "apiSends.title": "API sends",
  "apiSends.description":
    "Messages submitted through the email API or API SMTP. Mailbox messages are listed separately under Mailbox → Sent, not in this list.",
  "apiSends.mailLink": "Open mailbox",
} as const;

export function sendingClarityMessage(
  t: { (key: string): string; has(key: string): boolean },
  key: keyof typeof sendingClarityEnglish,
): string {
  return t.has(key) ? t(key) : sendingClarityEnglish[key];
}
