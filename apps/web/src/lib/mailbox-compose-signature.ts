export function mailboxSignature(signature: string) {
  const value = signature.trim();
  return value ? `\n\n--\n${value}` : "";
}

/** Only replace the managed footer; preserve a footer the author has edited. */
export function replaceMailboxSignature(text: string, previous: string, next: string) {
  const before = mailboxSignature(previous);
  const after = mailboxSignature(next);
  if (before && !text.endsWith(before)) return text;
  return (before ? text.slice(0, -before.length) : text) + after;
}

export function initialMailboxText(text: string, signature: string, forwarding = false) {
  const footer = mailboxSignature(signature);
  return forwarding && footer ? `${footer}\n\n${text}` : text + footer;
}
