/** Only an observed complete RFC header value is an alias. A provider/API ID
 * without its own brackets and domain never becomes one by reconstruction.
 * Header correlation is not authorization and never chooses a mailbox/team.
 */
export function mailboxMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return null;
  }
  const id = value.trim();
  if (
    id.length > 512 ||
    !/^[\x21-\x7e]+$/.test(id) ||
    !/^<[^<>\s@]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/.test(id) ||
    /["(),:;\\\[\]]/.test(id)
  )
    return null;
  return id;
}

/** Prefer the direct reply target, followed by nearest prior references.
 * These values remain untrusted hints within an already-authorized mailbox.
 */
export function mailboxReplyIds(input: { inReplyTo?: unknown; references?: unknown }): string[] {
  const references = Array.isArray(input.references)
    ? input.references.slice(-50)
    : typeof input.references === "string"
      ? [input.references]
      : [];
  return [
    ...new Set(
      [input.inReplyTo, ...references.reverse()]
        .map(mailboxMessageId)
        .filter((id): id is string => id !== null),
    ),
  ];
}
