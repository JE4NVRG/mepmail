"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { localMinute, teamAgentKeyChanges } from "@/lib/mailbox-team-agent-edit";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { AgentKeyHealth, CorreioClientSetup, ExpiryPresets } from "./correio-client-setup";
import styles from "./mailbox-agent-keys.module.css";
import registryStyles from "./mailboxes.module.css";

type Mailbox = { id: string; address: string; label: string };
type Props = {
  /** Mailboxes this person owns that an agent may work in (active ones only). */
  mailboxes: Mailbox[];
  onClose: () => void;
  mcpUrl?: string | undefined;
};
type Scope = "read" | "draft" | "send";
type Secret = { id: string; token: string };
type TeamKey = inferRouterOutputs<AppRouter>["mailboxes"]["teamAgentKeys"][number];
type UpdateInput = Parameters<
  ReturnType<typeof useTRPCClient>["mailboxes"]["updateTeamAgentKey"]["mutate"]
>[0];

/** The mailboxes a credential reaches now (its revoked rows left out). */
function liveMailboxes(key: TeamKey) {
  return key.mailboxes.filter((box) => !box.revoked);
}

/**
 * One agent credential (mmt_…) over several of the person's mailboxes. The agent
 * names the mailbox per call; without one it uses the default. Each mailbox keeps
 * its own permissions, limits, approval and activity record on the server.
 */
export function MailboxTeamAgentKeysDialog({ mailboxes, onClose, mcpUrl }: Props) {
  const t = useTranslations("mailboxes-agent");
  const format = useFormatter();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queries = useQueryClient();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const secretHeading = useRef<HTMLHeadingElement>(null);
  const active = useRef(true);
  const [label, setLabel] = useState("");
  // Revoking a credential cuts every mailbox it reaches: asked once more, inline.
  const [confirmingRevoke, setConfirmingRevoke] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>(() => mailboxes.map((box) => box.id));
  const [defaultId, setDefaultId] = useState("");
  const [draft, setDraft] = useState(true);
  const [send, setSend] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [minimumExpiry, setMinimumExpiry] = useState("");
  const [secret, setSecret] = useState<Secret | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [working, setWorking] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Editing one listed credential: the same form, saved in place (same token or grant).
  const [editing, setEditing] = useState<TeamKey | null>(null);
  const listing = useQuery(
    trpc.mailboxes.teamAgentKeys.queryOptions(undefined, { staleTime: 0, gcTime: 0 }),
  );
  const revoke = useMutation(trpc.mailboxes.revokeTeamAgentKey.mutationOptions({ gcTime: 0 }));
  const update = useMutation(trpc.mailboxes.updateTeamAgentKey.mutationOptions({ gcTime: 0 }));
  const resetRevoke = revoke.reset;
  const busy = working || revoke.isPending || update.isPending;

  useEffect(() => {
    active.current = true;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    labelInput.current?.focus();
    setMinimumExpiry(localMinute(new Date(Date.now() + 60_000)));
    return () => {
      active.current = false;
      resetRevoke();
    };
  }, [resetRevoke]);

  useEffect(() => {
    if (!active.current) return;
    if (secret) secretHeading.current?.focus();
    else labelInput.current?.focus();
  }, [secret]);

  function close() {
    if (!active.current) return;
    active.current = false;
    setSecret(null);
    setCopied(false);
    resetRevoke();
    dialog.current?.close();
    onClose();
  }

  async function refreshKeys() {
    await queries.invalidateQueries({
      queryKey: trpc.mailboxes.teamAgentKeys.queryKey(),
      exact: true,
      refetchType: "none",
    });
    // The Agentes panel behind this dialog lists the same credentials.
    void queries.invalidateQueries({ queryKey: trpc.mailboxAgents.overview.queryKey() });
    return listing.refetch({ throwOnError: true });
  }

  /** The form as a new credential starts: every mailbox, read + drafts, no expiry. */
  function resetForm() {
    setLabel("");
    setSelected(mailboxes.map((box) => box.id));
    setDefaultId("");
    setDraft(true);
    setSend(false);
    setExpiry("");
    setMinimumExpiry(localMinute(new Date(Date.now() + 60_000)));
  }

  /** The form filled with a credential as it is now on the server. */
  function startEdit(key: TeamKey) {
    const live = liveMailboxes(key);
    setEditing(key);
    setSecret(null);
    setConfirmingRevoke(null);
    setError("");
    setNotice("");
    setLabel(key.label);
    setSelected(live.map((box) => box.mailboxId));
    setDefaultId(live.find((box) => box.isDefault)?.mailboxId ?? "");
    setDraft(key.scopes.includes("draft"));
    setSend(key.scopes.includes("send"));
    setExpiry(key.expiresAt ? localMinute(key.expiresAt) : "");
    setMinimumExpiry(localMinute(new Date(Date.now() + 60_000)));
    dialog.current?.scrollTo({ top: 0 });
    labelInput.current?.focus();
  }

  function cancelEdit() {
    setEditing(null);
    setError("");
    resetForm();
  }

  async function saveEdit(key: TeamKey, scopes: Scope[]) {
    const changes = teamAgentKeyChanges(key, {
      label,
      mailboxIds: selected,
      scopes,
      defaultMailboxId: defaultId,
      expiry,
    });
    if (!Object.keys(changes).length) {
      setEditing(null);
      resetForm();
      setNotice(t("team.edit.unchanged"));
      return;
    }
    const input: UpdateInput = { id: key.id, expectedVersion: key.version, ...changes };
    setWorking(true);
    try {
      await update.mutateAsync(input);
    } catch (cause) {
      if (!active.current) return;
      const code = cause instanceof TRPCClientError ? cause.data?.code : null;
      if (code === "CONFLICT") {
        // Someone else saved first: show what is there now and let the person redo it.
        try {
          const refreshed = await refreshKeys();
          const fresh = refreshed.data?.find((row) => row.id === key.id && row.revokedAt === null);
          if (fresh && active.current) startEdit(fresh);
          else if (active.current) cancelEdit();
        } catch {
          // The message below still applies; the list shows its own error.
        }
        if (active.current) setError(t("team.edit.conflict"));
      } else if (code === "NOT_FOUND") {
        if (active.current) cancelEdit();
        void refreshKeys().catch(() => undefined);
        if (active.current) setError(t("team.edit.gone"));
      } else if (code === "FORBIDDEN") {
        setError(t("team.edit.forbidden"));
      } else if (
        code === "PRECONDITION_FAILED" &&
        cause instanceof Error &&
        /quota/.test(cause.message)
      ) {
        setError(t("team.edit.quota"));
      } else if (code === "BAD_REQUEST") {
        setError(t("team.edit.invalid"));
      } else {
        setError(t("error"));
      }
      return;
    } finally {
      update.reset();
      if (active.current) setWorking(false);
    }
    if (!active.current) return;
    setEditing(null);
    resetForm();
    try {
      await refreshKeys();
      if (active.current) setNotice(t("team.edit.saved"));
    } catch {
      if (active.current) setError(t("team.edit.savedRefreshError"));
    }
  }

  function toggle(mailboxId: string, on: boolean) {
    setSelected((current) =>
      on ? [...new Set([...current, mailboxId])] : current.filter((value) => value !== mailboxId),
    );
    if (!on && defaultId === mailboxId) setDefaultId("");
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    if (!selected.length) {
      setError(t("team.chooseMailbox"));
      return;
    }
    const scopes: Scope[] = ["read"];
    if (draft) scopes.push("draft");
    if (send) scopes.push("send");
    const expiresAt = expiry ? new Date(expiry) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      setError(t("futureExpiration"));
      return;
    }
    if (!label.trim()) {
      labelInput.current?.focus();
      return;
    }
    if (editing) {
      await saveEdit(editing, scopes);
      return;
    }
    setWorking(true);
    try {
      // Direct tRPC calls keep the secret response out of MutationCache.
      const result = await client.mailboxes.createTeamAgentKey.mutate({
        label: label.trim(),
        mailboxIds: selected,
        scopes,
        defaultMailboxId: defaultId || null,
        expiresAt,
      });
      const token = result.token;
      // Scrub the response even when it arrives after this opening closes.
      result.token = "";
      if (!active.current) return;
      // Only component state receives the token. Metadata refreshes never do.
      setSecret({ id: result.id, token });
      setCopied(false);
      setLabel("");
      try {
        await refreshKeys();
      } catch {
        if (active.current) setError(t("refreshError"));
      }
    } catch {
      if (active.current) setError(t("error"));
    } finally {
      if (active.current) setWorking(false);
    }
  }

  async function revokeKey(keyId: string) {
    if (busy) return;
    setError("");
    setNotice("");
    setRevokingId(keyId);
    setWorking(true);
    try {
      await revoke.mutateAsync({ id: keyId });
      if (!active.current) return;
      const refreshed = await refreshKeys();
      if (!refreshed.data?.some((key) => key.id === keyId && key.revokedAt != null))
        throw new Error("Revocation not confirmed");
      if (!active.current) return;
      setSecret((value) => (value?.id === keyId ? null : value));
      if (editing?.id === keyId) cancelEdit();
      setNotice(t("revokeSuccess"));
    } catch {
      if (active.current) setError(t("error"));
    } finally {
      resetRevoke();
      if (active.current) {
        setWorking(false);
        setRevokingId(null);
      }
    }
  }

  async function copyToken(text = secret?.token) {
    if (!secret || !text || copying || busy) return;
    setCopying(true);
    setError("");
    try {
      // Clipboard writes happen only in this explicit user click handler.
      await navigator.clipboard.writeText(text);
      if (active.current) setCopied(true);
    } catch {
      if (active.current) setError(t("copyError"));
    } finally {
      if (active.current) setCopying(false);
    }
  }

  function scopeLabel(scope: string) {
    if (scope === "read") return t("scopeRead");
    if (scope === "draft") return t("scopeDraft");
    if (scope === "send") return t("scopeSend");
    return t("scopeUnknown");
  }

  return (
    <dialog
      ref={dialog}
      className={`${registryStyles.dialog} ${styles.dialog}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={`${registryStyles.dialogHeader} ${styles.header}`}>
        <div>
          <h2 id={`${id}-title`}>{t("team.title")}</h2>
        </div>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={busy}
          onClick={close}
          aria-label={t("close")}
        >
          ×
        </button>
      </header>
      <p id={`${id}-description`} className={styles.description}>
        {t("team.description")}
      </p>
      {error && (
        <p className={styles.feedback} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.feedback} role="status">
          {notice}
        </p>
      )}

      {secret ? (
        <section className={styles.secret} aria-labelledby={`${id}-secret-title`}>
          <h3 id={`${id}-secret-title`} ref={secretHeading} tabIndex={-1}>
            {t("secretTitle")}
          </h3>
          <p id={`${id}-secret-hint`}>{t("secretHint")}</p>
          <label htmlFor={`${id}-token`}>{t("token")}</label>
          <textarea
            id={`${id}-token`}
            className={`ms-input ${styles.token}`}
            value={secret.token}
            readOnly
            rows={3}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-secret-hint`}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={busy || copying}
              onClick={() => void copyToken()}
            >
              {copied ? t("copied") : t("copy")}
            </button>
            <button
              type="button"
              className="ms-btn"
              disabled={busy || copying}
              onClick={() => {
                setSecret(null);
                setCopied(false);
                setDraft(true);
                setSend(false);
                setExpiry("");
                setMinimumExpiry(localMinute(new Date(Date.now() + 60_000)));
              }}
            >
              {t("savedToken")}
            </button>
          </div>
          {copied && (
            <p className={styles.copyStatus} role="status">
              {t("copySuccess")}
            </p>
          )}
          {mcpUrl ? (
            <CorreioClientSetup
              url={mcpUrl}
              token={secret.token}
              hint={t("team.mcpHint")}
              disabled={busy || copying}
              onCopy={(text) => copyToken(text)}
            />
          ) : null}
        </section>
      ) : (
        <form className={styles.form} onSubmit={(event) => void createKey(event)}>
          <h3>{editing ? t("team.edit.title", { label: editing.label }) : t("createTitle")}</h3>
          {editing ? (
            <p className={styles.description}>
              {t(editing.oauthClientId ? "team.edit.hintOauth" : "team.edit.hint")}
            </p>
          ) : null}
          <fieldset
            className={styles.fields}
            disabled={busy || listing.isPending || listing.isError}
          >
            <label className={styles.field} htmlFor={`${id}-label`}>
              <span>{t("label")}</span>
              <input
                id={`${id}-label`}
                ref={labelInput}
                className="ms-input"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("labelPlaceholder")}
                maxLength={80}
                required
                autoComplete="off"
              />
            </label>
            <fieldset className={styles.scopes}>
              <legend>{t("team.mailboxes")}</legend>
              <small>{t("team.mailboxesHint")}</small>
              {mailboxes.map((box) => (
                <label key={box.id} className={styles.scope}>
                  <input
                    type="checkbox"
                    checked={selected.includes(box.id)}
                    onChange={(event) => toggle(box.id, event.target.checked)}
                  />
                  <span>
                    <strong>{box.label}</strong>
                    <small>{box.address}</small>
                  </span>
                </label>
              ))}
              {/* Reached now but no longer offered (suspended, being deleted): only removable. */}
              {editing
                ? liveMailboxes(editing)
                    .filter((box) => !mailboxes.some((own) => own.id === box.mailboxId))
                    .map((box) => (
                      <label key={box.mailboxId} className={styles.scope}>
                        <input
                          type="checkbox"
                          checked={selected.includes(box.mailboxId)}
                          disabled={!selected.includes(box.mailboxId)}
                          onChange={(event) => toggle(box.mailboxId, event.target.checked)}
                        />
                        <span>
                          <strong>{box.address}</strong>
                          <small>{t("team.edit.unavailableBox")}</small>
                        </span>
                      </label>
                    ))
                : null}
            </fieldset>
            <label className={styles.field} htmlFor={`${id}-default`}>
              <span>{t("team.default")}</span>
              <select
                id={`${id}-default`}
                className="ms-input"
                value={defaultId}
                onChange={(event) => setDefaultId(event.target.value)}
              >
                <option value="">{t("team.noDefault")}</option>
                {mailboxes
                  .filter((box) => selected.includes(box.id))
                  .map((box) => (
                    <option key={box.id} value={box.id}>
                      {box.address}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset className={styles.scopes}>
              <legend>{t("permissions")}</legend>
              <label className={styles.scope}>
                <input type="checkbox" checked disabled />
                <span>
                  <strong>{t("scopeRead")}</strong>
                  <small>{t("readHint")}</small>
                </span>
              </label>
              <label className={styles.scope}>
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(event) => setDraft(event.target.checked)}
                />
                <span>
                  <strong>{t("scopeDraft")}</strong>
                  <small>{t("draftHint")}</small>
                </span>
              </label>
              <label className={`${styles.scope} ${styles.sendScope}`}>
                <input
                  type="checkbox"
                  checked={send}
                  onChange={(event) => setSend(event.target.checked)}
                />
                <span>
                  <strong>{t("scopeSend")}</strong>
                  <small>{t("sendHint")}</small>
                </span>
              </label>
            </fieldset>
            <label className={styles.field} htmlFor={`${id}-expiry`}>
              <span>{t("expiresAt")}</span>
              <input
                id={`${id}-expiry`}
                className="ms-input"
                type="datetime-local"
                value={expiry}
                min={minimumExpiry || undefined}
                onChange={(event) => setExpiry(event.target.value)}
                aria-describedby={`${id}-expiry-hint`}
              />
              <small id={`${id}-expiry-hint`}>{t("expirationHint")}</small>
            </label>
            <ExpiryPresets onPick={(date) => setExpiry(date ? localMinute(date) : "")} />
            <div className={styles.actions}>
              {editing ? (
                <button type="button" className="ms-btn" onClick={cancelEdit}>
                  {t("team.edit.cancel")}
                </button>
              ) : null}
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={!label.trim() || !selected.length}
              >
                {editing
                  ? working && revokingId === null
                    ? t("team.edit.saving")
                    : t("team.edit.save")
                  : working && revokingId === null
                    ? t("creating")
                    : t("create")}
              </button>
            </div>
          </fieldset>
        </form>
      )}

      <section
        className={styles.keys}
        aria-labelledby={`${id}-keys-title`}
        aria-busy={listing.isFetching || busy}
      >
        <h3 id={`${id}-keys-title`}>{t("team.existing")}</h3>
        {listing.isPending ? (
          <p className={styles.description} role="status">
            {t("loading")}
          </p>
        ) : listing.isError ? (
          <div className={styles.loadError}>
            <p role="alert">{t("loadError")}</p>
            <button
              type="button"
              className="ms-btn"
              disabled={listing.isFetching || busy}
              onClick={() => void listing.refetch()}
            >
              {t("retry")}
            </button>
          </div>
        ) : listing.data?.length ? (
          <ul className={styles.keyList}>
            {listing.data.map((key) => {
              const expired = key.expiresAt !== null && key.expiresAt.getTime() <= Date.now();
              const status = key.revokedAt ? "revoked" : expired ? "expired" : "active";
              return (
                <li key={key.id} className={styles.key}>
                  <div className={styles.keyDetails}>
                    <div className={styles.keyHeading}>
                      <strong>{key.label}</strong>
                      <span className={styles.badge}>{t(status)}</span>
                      {key.oauthClientId ? (
                        <span className={styles.badge}>{t("team.oauthBadge")}</span>
                      ) : null}
                    </div>
                    <AgentKeyHealth
                      expiresAt={key.expiresAt}
                      revokedAt={key.revokedAt}
                      lastUsedAt={key.lastUsedAt}
                      lastSentAt={key.lastSentAt}
                    />
                    <p>{key.scopes.map(scopeLabel).join(" · ")}</p>
                    <p>
                      {key.mailboxes
                        .filter((box) => !box.revoked)
                        .map((box) =>
                          box.isDefault
                            ? `${box.address} (${t("team.defaultBadge")})`
                            : box.address,
                        )
                        .join(", ") || t("team.mailboxCount", { count: 0 })}
                    </p>
                    <p>
                      {t("createdOn", {
                        date: format.dateTime(key.createdAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }),
                      })}
                    </p>
                    <p>
                      {key.expiresAt
                        ? t("expiresOn", {
                            date: format.dateTime(key.expiresAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }),
                          })
                        : t("noExpiration")}
                    </p>
                  </div>
                  {confirmingRevoke === key.id ? (
                    <div className={styles.revokeConfirm}>
                      <p>{t("revokeConfirmCredential", { label: key.label })}</p>
                      <button
                        type="button"
                        className="ms-btn"
                        disabled={busy}
                        onClick={() => setConfirmingRevoke(null)}
                      >
                        {t("revokeKeep")}
                      </button>
                      <button
                        type="button"
                        className={`ms-btn ${styles.revokeYes}`}
                        disabled={busy}
                        onClick={() => {
                          setConfirmingRevoke(null);
                          void revokeKey(key.id);
                        }}
                      >
                        {t("revoke")}
                      </button>
                    </div>
                  ) : (
                    <div className={styles.keyActions}>
                      {status === "active" && key.version ? (
                        <button
                          type="button"
                          className="ms-btn ms-btn-ghost"
                          disabled={busy || editing?.id === key.id}
                          aria-label={t("team.edit.label", { label: key.label })}
                          onClick={() => startEdit(key)}
                        >
                          {t("team.edit.action")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost"
                        disabled={busy || key.revokedAt !== null}
                        aria-label={t("revokeLabel", { label: key.label })}
                        onClick={() => setConfirmingRevoke(key.id)}
                      >
                        {revokingId === key.id ? t("revoking") : t("revoke")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={styles.empty}>
            <p>{t("team.emptyTitle")}</p>
            <p>{t("team.emptyBody")}</p>
          </div>
        )}
      </section>
      <footer className={styles.footer}>
        <button type="button" className="ms-btn" disabled={busy} onClick={close}>
          {t("close")}
        </button>
      </footer>
    </dialog>
  );
}
