"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { AgentKeyHealth, CorreioClientSetup, ExpiryPresets } from "./correio-client-setup";
import styles from "./mailbox-agent-keys.module.css";
import registryStyles from "./mailboxes.module.css";

type Props = {
  mailbox: { id: string; address: string };
  onClose: () => void;
  /** The Correio MCP endpoint, shown with a new key so an agent can connect at once. */
  mcpUrl?: string | undefined;
};
type Scope = "read" | "draft" | "send";
type Secret = { id: string; token: string };

function localMinute(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function MailboxAgentKeysDialog(props: Props) {
  // Changing boxes starts a fresh opening, including its one-time secret state.
  return <AgentKeysSession key={props.mailbox.id} {...props} />;
}

/** One line an MCP client takes: Claude Code's add command with the key as a header. */
function AgentKeysSession({ mailbox, onClose, mcpUrl }: Props) {
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
  const [read, setRead] = useState(true);
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
  const input = { mailboxId: mailbox.id };
  const listing = useQuery(
    trpc.mailboxes.agentKeys.queryOptions(input, { staleTime: 0, gcTime: 0 }),
  );
  const revoke = useMutation(trpc.mailboxes.revokeAgentKey.mutationOptions({ gcTime: 0 }));
  const resetRevoke = revoke.reset;
  const busy = working || revoke.isPending;

  useEffect(() => {
    active.current = true;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    labelInput.current?.focus();
    setMinimumExpiry(localMinute(new Date(Date.now() + 60_000)));
    return () => {
      active.current = false;
      // Revocation caches metadata only; creation bypasses MutationCache.
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
      queryKey: trpc.mailboxes.agentKeys.queryKey(input),
      exact: true,
      refetchType: "none",
    });
    return listing.refetch({ throwOnError: true });
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    const scopes: Scope[] = [];
    if (read) scopes.push("read");
    if (draft) scopes.push("draft");
    if (send) scopes.push("send");
    if (!scopes.length) {
      setError(t("chooseScope"));
      return;
    }
    const expiresAt = expiry ? new Date(expiry) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      setError(t("futureExpiration"));
      return;
    }
    if (!label.trim()) {
      labelInput.current?.focus();
      return;
    }
    setWorking(true);
    try {
      // Direct tRPC calls keep the secret response out of MutationCache.
      const result = await client.mailboxes.createAgentKey.mutate({
        ...input,
        label: label.trim(),
        scopes,
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
      await revoke.mutateAsync({ ...input, id: keyId });
      if (!active.current) return;
      const refreshed = await refreshKeys();
      if (!refreshed.data?.some((key) => key.id === keyId && key.revokedAt != null)) {
        throw new Error("Revocation not confirmed");
      }
      if (!active.current) return;
      setSecret((value) => (value?.id === keyId ? null : value));
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
          <h2 id={`${id}-title`}>{t("title")}</h2>
          <p className={styles.address}>{mailbox.address}</p>
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
        {t("description")}
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
                setRead(true);
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
              hint={t("mcpHint")}
              disabled={busy || copying}
              onCopy={(text) => copyToken(text)}
            />
          ) : null}
        </section>
      ) : (
        <form className={styles.form} onSubmit={(event) => void createKey(event)}>
          <h3>{t("createTitle")}</h3>
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
              <legend>{t("permissions")}</legend>
              <label className={styles.scope}>
                <input
                  type="checkbox"
                  checked={read}
                  onChange={(event) => setRead(event.target.checked)}
                />
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
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={!label.trim() || !(read || draft || send)}
              >
                {working && revokingId === null ? t("creating") : t("create")}
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
        <h3 id={`${id}-keys-title`}>{t("existingKeys")}</h3>
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
                    </div>
                    <AgentKeyHealth
                      expiresAt={key.expiresAt}
                      revokedAt={key.revokedAt}
                      lastUsedAt={key.lastUsedAt}
                      lastSentAt={key.lastSentAt}
                    />
                    <p>{key.scopes.map(scopeLabel).join(" · ")}</p>
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
                  <button
                    type="button"
                    className="ms-btn ms-btn-ghost"
                    disabled={busy || key.revokedAt !== null}
                    aria-label={t("revokeLabel", { label: key.label })}
                    onClick={() => void revokeKey(key.id)}
                  >
                    {revokingId === key.id ? t("revoking") : t("revoke")}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className={styles.empty}>
            <p>{t("emptyTitle")}</p>
            <p>{t("emptyBody")}</p>
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
