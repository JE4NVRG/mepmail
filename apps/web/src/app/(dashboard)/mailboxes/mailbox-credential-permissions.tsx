"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailbox-agent-keys.module.css";

type TeamKey = inferRouterOutputs<AppRouter>["mailboxes"]["teamAgentKeys"][number];
type Scope = "read" | "draft" | "send";
type Change = { mailboxId: string; scopes: Scope[] };
type Props = {
  credentialId: string;
  mailboxId?: string | undefined;
  onClose: () => void;
  onBusyChange?: ((busy: boolean) => void) | undefined;
};

function sameScopes(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((scope) => b.includes(scope));
}

/** Metadata edits must compare against the intersection, never a union of permissions. */
export function commonMailboxScopes(key: TeamKey): Scope[] {
  const live = key.mailboxes.filter((box) => !box.revoked);
  return (["read", "draft", "send"] as const).filter(
    (scope) => live.length > 0 && live.every((box) => box.scopes.includes(scope)),
  );
}

/** Only the send bit changes. Read/draft and every unedited row are preserved. */
export function mailboxSendChanges(key: TeamKey, selected: Record<string, boolean>): Change[] {
  return key.mailboxes
    .filter((box) => !box.revoked)
    .flatMap((box) => {
      const send = selected[box.mailboxId];
      if (send === undefined || send === box.scopes.includes("send")) return [];
      const scopes: Scope[] = box.scopes.filter((scope) => scope !== "send");
      if (send) scopes.push("send");
      return [{ mailboxId: box.mailboxId, scopes }];
    });
}

/** Confirm all live rows, including untouched ones, and the unchanged grant membership. */
export function mailboxPermissionsConfirmed(before: TeamKey, after: TeamKey, changes: Change[]) {
  const live = before.mailboxes.filter((box) => !box.revoked);
  const fresh = after.mailboxes.filter((box) => !box.revoked);
  return (
    after.id === before.id &&
    after.oauthClientId === before.oauthClientId &&
    after.label === before.label &&
    after.expiresAt?.getTime() === before.expiresAt?.getTime() &&
    after.revokedAt === null &&
    after.version !== before.version &&
    before.mailboxes.length === after.mailboxes.length &&
    before.mailboxes.every((box) =>
      after.mailboxes.some((row) => row.mailboxId === box.mailboxId && row.revoked === box.revoked),
    ) &&
    live.length === fresh.length &&
    live.every((box) => {
      const row = fresh.find((candidate) => candidate.mailboxId === box.mailboxId);
      const expected =
        changes.find((change) => change.mailboxId === box.mailboxId)?.scopes ?? box.scopes;
      return row && row.isDefault === box.isDefault && sameScopes(row.scopes, expected);
    })
  );
}

export function MailboxCredentialPermissions(props: Props) {
  const t = useTranslations("mailboxes-agent");
  const trpc = useTRPC();
  const listing = useQuery(
    trpc.mailboxes.teamAgentKeys.queryOptions(undefined, {
      staleTime: 0,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  );
  if (listing.isPending) return <p role="status">{t("loading")}</p>;
  const credential = listing.data?.find((key) => key.id === props.credentialId);
  if (listing.isError || !credential)
    return (
      <div className={styles.feedback}>
        <p role="alert">{t(listing.isError ? "loadError" : "team.edit.gone")}</p>
        <button type="button" className="ms-btn" onClick={() => void listing.refetch()}>
          {t("retry")}
        </button>
        <button type="button" className="ms-btn" onClick={props.onClose}>
          {t("team.edit.cancel")}
        </button>
      </div>
    );
  return (
    <MailboxCredentialPermissionsForm key={props.credentialId} {...props} credential={credential} />
  );
}

/** Inline in either the Agents panel or the existing mailbox dialog; never mints a token. */
export function MailboxCredentialPermissionsForm({
  credential,
  mailboxId,
  onClose,
  onBusyChange,
}: Props & { credential: TeamKey }) {
  const t = useTranslations("mailboxes-agent");
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queries = useQueryClient();
  const id = useId();
  const active = useRef(true);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [baseline, setBaseline] = useState(credential);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    active.current = true;
    heading.current?.focus();
    return () => {
      active.current = false;
    };
  }, []);
  const rows = baseline.mailboxes.filter(
    (box) => !box.revoked && (!mailboxId || box.mailboxId === mailboxId),
  );
  const changes = mailboxSendChanges(baseline, selected);
  const editable =
    baseline.revokedAt === null &&
    !!baseline.version &&
    (!baseline.expiresAt || baseline.expiresAt.getTime() > Date.now()) &&
    rows.length > 0;

  async function invalidate() {
    await Promise.all([
      queries.invalidateQueries({ queryKey: trpc.mailboxAgents.overview.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.teamAgentKeys.queryKey() }),
      // Prefix: refresh every mailbox view, not only the row currently open.
      queries.invalidateQueries({ queryKey: trpc.mailboxes.agentKeys.queryKey() }),
    ]);
  }
  function working(value: boolean) {
    lock.current = value;
    if (active.current) setBusy(value);
    onBusyChange?.(value);
  }
  async function reload() {
    if (lock.current) return;
    working(true);
    try {
      const keys = await client.mailboxes.teamAgentKeys.query();
      const fresh = keys.find((key) => key.id === baseline.id);
      if (!active.current) return;
      if (!fresh) {
        setError(t("team.edit.gone"));
        return;
      }
      setBaseline(fresh);
      setSelected({});
      setBlocked(false);
      setError("");
      setNotice("");
    } catch {
      if (active.current) setError(t("loadError"));
    } finally {
      working(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || blocked || !editable || !changes.length) return;
    working(true);
    setError("");
    setNotice("");
    let written = false;
    try {
      await client.mailboxes.updateTeamAgentKey.mutate({
        id: baseline.id,
        expectedVersion: baseline.version,
        mailboxScopes: changes,
      });
      written = true;
      const keys = await client.mailboxes.teamAgentKeys.query();
      const fresh = keys.find((key) => key.id === baseline.id);
      if (!fresh || !mailboxPermissionsConfirmed(baseline, fresh, changes))
        throw new Error("readback_mismatch");
      if (!active.current) return;
      setBaseline(fresh);
      setSelected({});
      setNotice(t("perMailbox.saved"));
    } catch (cause) {
      if (!active.current) return;
      const code = (cause as { data?: { code?: string } })?.data?.code;
      // Never retry an uncertain write against the old version or silently replace the edit.
      setBlocked(true);
      setError(
        t(
          code === "CONFLICT"
            ? "perMailbox.conflict"
            : written
              ? "perMailbox.unconfirmed"
              : "perMailbox.failed",
        ),
      );
    } finally {
      // Refresh other consumers even after uncertain writes; success still requires exact readback above.
      await invalidate().catch(() => undefined);
      working(false);
    }
  }
  return (
    <section className={styles.permissionsEditor} aria-labelledby={`${id}-title`} aria-busy={busy}>
      <h4 id={`${id}-title`} ref={heading} tabIndex={-1}>
        {t("perMailbox.title", { label: baseline.label })}
      </h4>
      <p id={`${id}-hint`} className={styles.description}>
        {t("perMailbox.hint")}
      </p>
      {error ? (
        <p className={styles.feedback} role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.feedback} role="status">
          {notice}
        </p>
      ) : null}
      {!editable ? <p role="alert">{t("team.edit.gone")}</p> : null}
      <form onSubmit={(event) => void save(event)} aria-describedby={`${id}-hint`}>
        <fieldset className={styles.fields} disabled={busy || blocked || !editable}>
          <legend>{t("perMailbox.mailboxes")}</legend>
          <ul className={styles.permissionRows}>
            {rows.map((box) => (
              <li key={box.mailboxId} className={styles.permissionRow}>
                <div>
                  <strong className={styles.permissionAddress}>{box.address}</strong>
                  <p className={styles.description}>
                    {t("perMailbox.preserved", {
                      read: t(
                        box.scopes.includes("read") ? "perMailbox.allowed" : "perMailbox.denied",
                      ),
                      draft: t(
                        box.scopes.includes("draft") ? "perMailbox.allowed" : "perMailbox.denied",
                      ),
                    })}
                  </p>
                </div>
                <label className={styles.permissionToggle}>
                  <input
                    type="checkbox"
                    checked={selected[box.mailboxId] ?? box.scopes.includes("send")}
                    aria-label={t("perMailbox.sendLabel", { address: box.address })}
                    onChange={(event) => {
                      setSelected((current) => ({
                        ...current,
                        [box.mailboxId]: event.target.checked,
                      }));
                      setNotice("");
                    }}
                  />
                  <span>{t("perMailbox.send")}</span>
                </label>
              </li>
            ))}
          </ul>
          <p role="status" className={styles.description}>
            {busy ? t("perMailbox.saving") : t("perMailbox.pending", { count: changes.length })}
          </p>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={!changes.length}>
            {t("team.edit.save")}
          </button>
        </fieldset>
        <div className={styles.actions}>
          {blocked ? (
            <button type="button" className="ms-btn" disabled={busy} onClick={() => void reload()}>
              {t("perMailbox.reload")}
            </button>
          ) : null}
          <button type="button" className="ms-btn" disabled={busy} onClick={onClose}>
            {t("team.edit.cancel")}
          </button>
        </div>
      </form>
    </section>
  );
}
