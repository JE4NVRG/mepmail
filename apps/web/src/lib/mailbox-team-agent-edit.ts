/**
 * Editar uma credencial de agente: what the form changed, as updateTeamAgentKey takes it.
 * A field left out keeps its value on the server, so only what differs is sent (the
 * audit row then names exactly that).
 */
type Scope = "read" | "draft" | "send";

/** A date as a datetime-local input shows it, to the minute, in local time. */
export function localMinute(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export interface TeamAgentKeyChanges {
  label?: string;
  mailboxIds?: string[];
  scopes?: Scope[];
  defaultMailboxId?: string | null;
  expiresAt?: Date | null;
}

export function teamAgentKeyChanges(
  key: {
    label: string;
    scopes: readonly string[];
    expiresAt: Date | null;
    mailboxes: readonly { mailboxId: string; isDefault: boolean; revoked: boolean }[];
  },
  form: {
    label: string;
    mailboxIds: string[];
    scopes: Scope[];
    /** "" = no default. */
    defaultMailboxId: string;
    /** The datetime-local value ("" = never expires). */
    expiry: string;
  },
): TeamAgentKeyChanges {
  const live = key.mailboxes.filter((box) => !box.revoked);
  const changes: TeamAgentKeyChanges = {};
  const label = form.label.trim();
  if (label !== key.label) changes.label = label;
  if (
    !sameSet(
      form.mailboxIds,
      live.map((box) => box.mailboxId),
    )
  )
    changes.mailboxIds = [...form.mailboxIds];
  if (!sameSet(form.scopes, key.scopes)) changes.scopes = [...form.scopes];
  const currentDefault = live.find((box) => box.isDefault)?.mailboxId ?? null;
  if ((form.defaultMailboxId || null) !== currentDefault)
    changes.defaultMailboxId = form.defaultMailboxId || null;
  // Compared to the minute the input shows: an untouched expiry is not "changed".
  if (form.expiry !== (key.expiresAt ? localMinute(key.expiresAt) : ""))
    changes.expiresAt = form.expiry ? new Date(form.expiry) : null;
  return changes;
}
