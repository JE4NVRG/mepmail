/**
 * Regras automáticas on the client: a rule's match as the server keeps it, and whether
 * it takes mail from an address (for "Aplicar às que já estão na Entrada"). The server
 * (packages/core/src/mailbox-rules.ts) normalizes and validates again; these mirror it.
 */
export type MailboxRuleMatchKind = "sender" | "domain";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Sender: trimmed, lower case. Domain: also without a leading "@" or a trailing ".". */
export function normalizeRuleValue(kind: MailboxRuleMatchKind, value: string): string {
  const folded = value.trim().toLowerCase();
  return kind === "sender" ? folded : folded.replace(/^@+/, "").replace(/\.+$/, "");
}

/** A normalized value the server would take (it has the last word). */
export function validRuleValue(kind: MailboxRuleMatchKind, value: string): boolean {
  return kind === "sender"
    ? EMAIL.test(value) && value.length <= 320
    : DOMAIN.test(value) && value.length <= 253;
}

/** The domain part of an address, lower case ("" when there is none). */
export function senderDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Whether a rule takes mail from this address: the exact sender, or the domain and its subdomains. */
export function ruleCovers(
  match: { kind: MailboxRuleMatchKind; value: string },
  from: string,
): boolean {
  const address = from.trim().toLowerCase();
  if (match.kind === "sender") return address === match.value;
  const domain = senderDomain(address);
  return domain === match.value || domain.endsWith(`.${match.value}`);
}
