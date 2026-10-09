"use client";

import { useMutation } from "@tanstack/react-query";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
  CORREIO_MCP_CLIENTS,
  type CorreioMcpClient,
  correioClientSnippet,
} from "@/lib/correio-mcp-clients";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-agent-keys.module.css";

type Props = {
  url: string;
  token: string;
  hint: string;
  disabled: boolean;
  /** The dialog's own clipboard handler, so copy feedback stays in one place. */
  onCopy: (text: string) => Promise<void>;
};

/**
 * Beside a new agent key: the setup for each MCP client (pick one, copy it)
 * and a live connection test against the public Correio endpoint.
 */
export function CorreioClientSetup({ url, token, hint, disabled, onCopy }: Props) {
  const t = useTranslations("mailboxes-agent");
  const trpc = useTRPC();
  const id = useId();
  const [client, setClient] = useState<CorreioMcpClient>("claude-code");
  const test = useMutation(trpc.mailboxes.testAgentConnection.mutationOptions({ gcTime: 0 }));
  const snippet = correioClientSnippet(client, url, token);
  const result = test.data;
  return (
    <div className={styles.mcpSetup}>
      <h3>{t("mcpTitle")}</h3>
      <p id={`${id}-hint`}>{hint}</p>
      <fieldset className={styles.clients} aria-label={t("clients.label")}>
        {CORREIO_MCP_CLIENTS.map((option) => (
          <button
            key={option}
            type="button"
            className={styles.client}
            aria-pressed={option === client}
            onClick={() => setClient(option)}
          >
            {t(`clients.${option}`)}
          </button>
        ))}
      </fieldset>
      <p className={styles.clientWhere}>
        {t(`clients.where.${client}`, { file: snippet.file ?? "", url })}
      </p>
      <label htmlFor={`${id}-snippet`}>
        {snippet.kind === "command" ? t("clients.command") : t("clients.config")}
      </label>
      <textarea
        id={`${id}-snippet`}
        className={`ms-input ${styles.token} ${styles.snippet}`}
        value={snippet.text}
        readOnly
        rows={Math.min(12, Math.max(3, snippet.text.split("\n").length + 1))}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-hint`}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className="ms-btn"
          disabled={disabled}
          onClick={() => void onCopy(snippet.text)}
        >
          {t("clients.copy")}
        </button>
        <button
          type="button"
          className="ms-btn"
          disabled={disabled || test.isPending}
          onClick={() => test.mutate({ token })}
        >
          {test.isPending ? t("test.running") : t("test.run")}
        </button>
      </div>
      {test.isError ? (
        <p className={styles.testResult} role="alert" data-ok="false">
          {t("test.unexpected")}
        </p>
      ) : result ? (
        <div className={styles.testResult} role="status" data-ok={result.ok}>
          {result.ok ? (
            <>
              <p>
                {t("test.ok", {
                  count: result.mailboxes.filter((box) => box.available).length,
                  ms: result.latencyMs,
                })}
              </p>
              <ul>
                {result.mailboxes.map((box) => (
                  <li key={box.address}>
                    <span>{box.address}</span>
                    <span>
                      {box.available
                        ? box.scopes.map((scope) => t(`test.scope.${scopeKey(scope)}`)).join(" · ")
                        : t("test.unavailable")}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>{t(`test.${result.reason}`)}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function scopeKey(scope: string): "read" | "draft" | "send" | "other" {
  return scope === "read" || scope === "draft" || scope === "send" ? scope : "other";
}

const WEEK_MS = 7 * 24 * 3600_000;

/** The health line under each key: status, last use and last send, from the key's own stamps. */
export function AgentKeyHealth({
  expiresAt,
  revokedAt,
  lastUsedAt,
  lastSentAt,
}: {
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  lastSentAt: Date | null;
}) {
  const t = useTranslations("mailboxes-agent");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const left = expiresAt ? expiresAt.getTime() - now.getTime() : null;
  const status = revokedAt
    ? "revoked"
    : left !== null && left <= 0
      ? "expired"
      : left !== null && left <= WEEK_MS
        ? "expiring"
        : lastUsedAt
          ? "healthy"
          : "unused";
  return (
    <p className={styles.health} data-status={status}>
      <span className={styles.healthDot} aria-hidden="true" />
      <span>
        {t(`health.${status}`)}
        {" · "}
        {lastUsedAt
          ? t("health.lastUsed", { when: format.relativeTime(lastUsedAt, now) })
          : t("health.neverUsed")}
        {lastSentAt
          ? ` · ${t("health.lastSent", { when: format.relativeTime(lastSentAt, now) })}`
          : ""}
      </span>
    </p>
  );
}

const PRESET_DAYS = [30, 90, 365] as const;

/** One-click expiries beside the date field; "never" clears it (keys without expiry are allowed). */
export function ExpiryPresets({ onPick }: { onPick: (date: Date | null) => void }) {
  const t = useTranslations("mailboxes-agent");
  return (
    <fieldset className={styles.presets} aria-label={t("presets.label")}>
      {PRESET_DAYS.map((days) => (
        <button
          key={days}
          type="button"
          className={styles.client}
          onClick={() => onPick(new Date(Date.now() + days * 24 * 3600_000))}
        >
          {t("presets.days", { days })}
        </button>
      ))}
      <button type="button" className={styles.client} onClick={() => onPick(null)}>
        {t("presets.never")}
      </button>
    </fieldset>
  );
}
