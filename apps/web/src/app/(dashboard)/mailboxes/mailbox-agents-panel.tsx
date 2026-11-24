"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { ACTIVITY_ACTION_KEYS } from "./mailbox-activity";
import own from "./mailbox-agents-panel.module.css";
import { MailboxCredentialPermissions } from "./mailbox-credential-permissions";
import { MailboxBlockedRecipients } from "./mailbox-recipient-unblock";
import styles from "./mailboxes.module.css";

/**
 * Agentes (Jean, 2026-10-11): in one place, for the mailboxes this person owns,
 * - what agents asked them to send (Para, Cc and Cco shown), to send, open or discard;
 * - every agent that can reach them (key, team credential, OAuth app), with what it may
 *   do, the mailboxes, last use and last send, and Revogar with a confirmation;
 * - what the agents did lately.
 * Sending, discarding and revoking are the Correio's own actions (mailboxes router).
 */
export function MailboxAgentsPanel({
  onConnect,
  onNewAgentMailbox,
  agentMailboxCount,
}: {
  /** "Conectar agente" (the mailbox's own dialog, opened by the Correio). */
  onConnect?: (() => void) | undefined;
  /** Opens "Nova caixa" focused on creating a dedicated agent mailbox. */
  onNewAgentMailbox?: (() => void) | undefined;
  /** Number of dedicated agent mailboxes owned/visible on this team. */
  agentMailboxCount?: number | undefined;
}) {
  const t = useTranslations("mailboxes-agent.panel");
  const tAgent = useTranslations("mailboxes-agent");
  const tActivity = useTranslations("mailboxes-activity");
  const locale = useLocale();
  const router = useRouter();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const overview = useQuery(
    trpc.mailboxAgents.overview.queryOptions(undefined, { refetchInterval: 60_000 }),
  );
  const send = useMutation(trpc.mailboxes.queueDraft.mutationOptions());
  const discard = useMutation(trpc.mailboxes.setTrash.mutationOptions());
  const revokeKey = useMutation(trpc.mailboxes.revokeAgentKey.mutationOptions({ gcTime: 0 }));
  const revokeCredential = useMutation(
    trpc.mailboxes.revokeTeamAgentKey.mutationOptions({ gcTime: 0 }),
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editingCredential, setEditingCredential] = useState<string | null>(null);
  const [permissionsBusy, setPermissionsBusy] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [expandedMailboxes, setExpandedMailboxes] = useState<ReadonlySet<string>>(new Set());
  const [showAllActivity, setShowAllActivity] = useState(false);
  // Why the last approval of a card did not go out, shown on that card.
  const [sendError, setSendError] = useState<{
    itemId: string;
    message: string;
    /** Addresses the send was refused for (recipient_blocked), each one liftable. */
    blocked: string[];
    /** Those already unblocked here (their rows stay, with any provider warning). */
    lifted: string[];
  } | null>(null);
  const busy =
    permissionsBusy ||
    send.isPending ||
    discard.isPending ||
    revokeKey.isPending ||
    revokeCredential.isPending;
  const when = (value: Date | string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
      new Date(value),
    );
  const refresh = () =>
    queries.invalidateQueries({ queryKey: trpc.mailboxAgents.overview.queryKey() });
  const failed = (cause: unknown) => {
    const code = (cause as { data?: { code?: string } })?.data?.code;
    toast(t(code === "CONFLICT" ? "changed" : "error"), "warn");
    void refresh();
  };
  /** An approval the server refused: nothing went out; say why on the card. */
  const sendFailed = (itemId: string, cause: unknown) => {
    const code = (cause as { data?: { code?: string } })?.data?.code;
    const reason = cause instanceof Error ? cause.message : "";
    if (code === "CONFLICT") {
      failed(cause);
      return;
    }
    const key =
      code === "FORBIDDEN" && /recipient_blocked/.test(reason)
        ? "recipientBlocked"
        : code === "PRECONDITION_FAILED" && reason === "quota"
          ? "quota"
          : code === "PRECONDITION_FAILED" && reason === "trial_limit"
            ? "trialLimit"
            : code === "PRECONDITION_FAILED" && reason === "mailbox_transport_unavailable"
              ? "unavailable"
              : code === "FORBIDDEN"
                ? "forbidden"
                : "generic";
    // The server names the blocked addresses (data.blockedRecipients) when it can.
    const blocked = (cause as { data?: { blockedRecipients?: unknown } })?.data?.blockedRecipients;
    const named = Array.isArray(blocked) ? blocked.filter((v) => typeof v === "string") : [];
    const message =
      key === "recipientBlocked" && named.length
        ? t("approvals.errors.recipientBlockedNamed", {
            recipients: named.join(", "),
            count: named.length,
          })
        : t(`approvals.errors.${key}`);
    setSendError({
      itemId,
      message,
      blocked: key === "recipientBlocked" ? named : [],
      lifted: [],
    });
    toast(message, "danger");
    void refresh();
  };
  const data = overview.data;

  if (overview.isPending) return <p className={styles.hint}>{t("loading")}</p>;
  if (overview.isError || !data)
    return (
      <div role="alert">
        <p>{t("error")}</p>
        <button type="button" className="ms-btn" onClick={() => void overview.refetch()}>
          {t("retry")}
        </button>
      </div>
    );

  const agentTerm = agentSearch.trim().toLowerCase();
  const filteredCredentials = agentTerm
    ? data.credentials.filter(
        (c) =>
          c.label.toLowerCase().includes(agentTerm) ||
          c.mailboxes.some((m) => m.address.toLowerCase().includes(agentTerm)),
      )
    : data.credentials;
  const visibleActivity = showAllActivity ? data.activity : data.activity.slice(0, 8);
  const toggleExpandMailboxes = (credentialId: string) => {
    setExpandedMailboxes((prev) => {
      const next = new Set(prev);
      if (next.has(credentialId)) next.delete(credentialId);
      else next.add(credentialId);
      return next;
    });
  };

  const autonomousCount = data.credentials.filter((c) => c.scopes.includes("send")).length;
  const copilotCount = data.credentials.filter(
    (c) => c.scopes.includes("draft") && !c.scopes.includes("send"),
  ).length;

  return (
    <div className={own.panel}>
      <div className={own.summary}>
        <div className={own.statCard}>
          <span>{t("agents.autonomousCount")}</span>
          <strong>{autonomousCount}</strong>
        </div>
        <div className={own.statCard}>
          <span>{t("agents.supervisedCount")}</span>
          <strong>{copilotCount}</strong>
        </div>
        <div className={own.statCard}>
          <span>{t("approvals.title")}</span>
          <strong>{data.approvals.length}</strong>
        </div>
        {typeof agentMailboxCount === "number" ? (
          <div className={own.statCard}>
            <span>{t("agents.dedicatedBoxes")}</span>
            <strong>{agentMailboxCount}</strong>
          </div>
        ) : null}
        <div className={own.statCard}>
          <span>{t("activity.title")}</span>
          <strong>{data.activity.length}</strong>
        </div>
      </div>

      <section aria-labelledby="agents-approvals">
        <header className={own.head}>
          <h3 id="agents-approvals">
            {t("approvals.title")}
            {data.approvals.length ? (
              <span className={own.count}>{data.approvals.length}</span>
            ) : null}
          </h3>
        </header>
        {!data.approvals.length ? (
          <p className={styles.hint}>{t("approvals.empty")}</p>
        ) : (
          <ul className={own.cards}>
            {data.approvals.map((item) => {
              const key = `approve:${item.itemId}`;
              const recipients = item.to.length + item.cc.length + item.bcc.length;
              return (
                <li key={item.itemId} className={own.card}>
                  <p className={own.meta}>
                    {t("approvals.asked", {
                      agent: item.agentLabel ?? tActivity("actors.agent"),
                      mailbox: item.address,
                      date: when(item.requestedAt),
                    })}
                  </p>
                  <strong className={own.subject}>
                    {item.subject || t("approvals.noSubject")}
                  </strong>
                  <dl className={own.recipients}>
                    {item.to.length ? (
                      <>
                        <dt>{t("approvals.to")}</dt>
                        <dd>{item.to.join(", ")}</dd>
                      </>
                    ) : null}
                    {item.cc.length ? (
                      <>
                        <dt>Cc</dt>
                        <dd>{item.cc.join(", ")}</dd>
                      </>
                    ) : null}
                    {item.bcc.length ? (
                      <>
                        <dt>{t("approvals.bcc")}</dt>
                        <dd>{item.bcc.join(", ")}</dd>
                      </>
                    ) : null}
                  </dl>
                  {item.preview ? <p className={own.preview}>{item.preview}</p> : null}
                  {sendError?.itemId === item.itemId ? (
                    <div
                      className={own.sendError}
                      role={
                        sendError.blocked.length &&
                        sendError.blocked.every((value) => sendError.lifted.includes(value))
                          ? "status"
                          : "alert"
                      }
                    >
                      <p>
                        {sendError.blocked.length &&
                        sendError.blocked.every((value) => sendError.lifted.includes(value))
                          ? t("approvals.errors.unblockedAll")
                          : sendError.message}
                      </p>
                      <MailboxBlockedRecipients
                        addresses={sendError.blocked}
                        onUnblocked={(address) => {
                          const lifted = [...new Set([...sendError.lifted, address])];
                          // Every blocked recipient lifted: Enviar works again.
                          if (sendError.blocked.every((value) => lifted.includes(value)))
                            toast(t("approvals.errors.unblockedAll"));
                          setSendError({ ...sendError, lifted });
                        }}
                      />
                    </div>
                  ) : null}
                  {confirming === key ? (
                    <div className={own.actions}>
                      <span>{t("approvals.confirm", { count: recipients })}</span>
                      <button
                        type="button"
                        className="ms-btn ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {t("keep")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary ms-btn-sm"
                        disabled={busy}
                        onClick={async () => {
                          setSendError(null);
                          try {
                            await send.mutateAsync({
                              mailboxId: item.mailboxId,
                              id: item.itemId,
                              expectedRevision: item.revision,
                            });
                            setConfirming(null);
                            toast(t("approvals.sent"));
                            await refresh();
                          } catch (cause) {
                            setConfirming(null);
                            sendFailed(item.itemId, cause);
                          }
                        }}
                      >
                        {t("approvals.send")}
                      </button>
                    </div>
                  ) : confirming === `discard:${item.itemId}` ? (
                    <div className={own.actions}>
                      <span>{t("approvals.discardConfirm")}</span>
                      <button
                        type="button"
                        className="ms-btn ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {t("keep")}
                      </button>
                      <button
                        type="button"
                        className={own.danger}
                        disabled={busy}
                        onClick={async () => {
                          try {
                            await discard.mutateAsync({
                              mailboxId: item.mailboxId,
                              id: item.itemId,
                              expectedRevision: item.revision,
                              trashed: true,
                            });
                            setConfirming(null);
                            toast(t("approvals.discarded"));
                            await refresh();
                          } catch (cause) {
                            failed(cause);
                          }
                        }}
                      >
                        {t("approvals.discard")}
                      </button>
                    </div>
                  ) : (
                    <div className={own.actions}>
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary ms-btn-sm"
                        disabled={busy || !recipients}
                        onClick={() => setConfirming(key)}
                      >
                        {t("approvals.send")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-sm"
                        onClick={() =>
                          router.push(
                            `/mail?mailbox=${encodeURIComponent(item.mailboxId)}&item=${encodeURIComponent(item.itemId)}`,
                          )
                        }
                      >
                        {t("approvals.open")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(`discard:${item.itemId}`)}
                      >
                        {t("approvals.discard")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="agents-connected">
        <header className={own.head}>
          <h3 id="agents-connected">
            {t("agents.title")}
            {data.credentials.length ? (
              <span className="ms-badge ms-badge-neutral ms-mono">{data.credentials.length}</span>
            ) : null}
          </h3>
          <div className={own.headActions}>
            {onNewAgentMailbox ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary ms-btn-sm"
                onClick={onNewAgentMailbox}
              >
                {t("agents.newAgentBox")}
              </button>
            ) : null}
            {onConnect ? (
              <button type="button" className="ms-btn ms-btn-primary ms-btn-sm" onClick={onConnect}>
                {t("agents.connect")}
              </button>
            ) : null}
          </div>
        </header>
        {data.credentials.length > 4 ? (
          <input
            type="search"
            className="ms-input"
            style={{ width: "min(100%, 360px)" }}
            placeholder={t("agents.search")}
            value={agentSearch}
            onChange={(e) => setAgentSearch(e.target.value)}
          />
        ) : null}
        {!data.credentials.length ? (
          <p className={styles.hint}>{t("agents.empty")}</p>
        ) : (
          <ul className={own.list}>
            {filteredCredentials.map((agent) => {
              const key = `revoke:${agent.credentialId}`;
              const expanded = expandedMailboxes.has(agent.credentialId);
              const visibleBoxes = expanded ? agent.mailboxes : agent.mailboxes.slice(0, 2);
              const hiddenCount = Math.max(0, agent.mailboxes.length - 2);
              const modeClass = agent.scopes.includes("send")
                ? own.modeAutonomous
                : agent.scopes.includes("draft")
                  ? own.modeCopilot
                  : own.tag;
              const modeLabel = agent.scopes.includes("send")
                ? t("agents.modeAutonomous")
                : agent.scopes.includes("draft")
                  ? t("agents.modeCopilot")
                  : t("agents.modeReadOnly");
              return (
                <li key={agent.credentialId}>
                  <div className={own.agent}>
                    <strong>{agent.label}</strong>
                    <span className={own.tags}>
                      <span className={modeClass}>{modeLabel}</span>
                      <span className={own.tag}>{t(`agents.kind.${agent.kind}`)}</span>
                      {agent.scopes.map((scope) => (
                        <span key={scope} className={own.tag}>
                          {t(`agents.scope.${scope}`)}
                        </span>
                      ))}
                    </span>
                    <div className={own.mailboxes}>
                      {visibleBoxes.map((m) => (
                        <span key={m.mailboxId} className={own.mailboxPill}>
                          {m.address}
                        </span>
                      ))}
                      {hiddenCount > 0 ? (
                        <button
                          type="button"
                          className={own.mailboxToggle}
                          aria-expanded={expanded}
                          onClick={() => toggleExpandMailboxes(agent.credentialId)}
                        >
                          {expanded
                            ? t("agents.lessMailboxes")
                            : t("agents.moreMailboxes", { count: hiddenCount })}
                        </button>
                      ) : null}
                    </div>
                    <small>
                      {agent.lastUsedAt
                        ? t("agents.used", { date: when(agent.lastUsedAt) })
                        : t("agents.unused")}
                      {agent.lastSentAt
                        ? ` · ${t("agents.sent", { date: when(agent.lastSentAt) })}`
                        : ""}
                      {` · ${tAgent("perMailbox.summary")}`}
                    </small>
                  </div>
                  {confirming === key ? (
                    <div className={own.actions}>
                      <span>{t("agents.revokeConfirm", { count: agent.mailboxes.length })}</span>
                      <button
                        type="button"
                        className="ms-btn ms-btn-secondary ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        {t("keep")}
                      </button>
                      <button
                        type="button"
                        className="ms-btn ms-btn-destructive ms-btn-sm"
                        disabled={busy}
                        onClick={async () => {
                          try {
                            const firstMailboxId = agent.mailboxes[0]?.mailboxId;
                            if (agent.kind === "mailbox" && firstMailboxId)
                              await revokeKey.mutateAsync({
                                mailboxId: firstMailboxId,
                                id: agent.credentialId,
                              });
                            else await revokeCredential.mutateAsync({ id: agent.credentialId });
                            setConfirming(null);
                            toast(t("agents.revoked", { agent: agent.label }));
                            await refresh();
                          } catch (cause) {
                            failed(cause);
                          }
                        }}
                      >
                        {t("agents.revoke")}
                      </button>
                    </div>
                  ) : (
                    <div className={own.actions}>
                      {agent.kind !== "mailbox" ? (
                        <button
                          type="button"
                          className="ms-btn ms-btn-secondary ms-btn-sm"
                          disabled={busy}
                          aria-label={tAgent("perMailbox.editLabel", { label: agent.label })}
                          aria-expanded={editingCredential === agent.credentialId}
                          onClick={() => {
                            setConfirming(null);
                            setEditingCredential(agent.credentialId);
                          }}
                        >
                          {tAgent("perMailbox.action")}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ms-btn ms-btn-destructive ms-btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(key)}
                      >
                        {t("agents.revoke")}
                      </button>
                    </div>
                  )}
                  {editingCredential === agent.credentialId ? (
                    <MailboxCredentialPermissions
                      credentialId={agent.credentialId}
                      onBusyChange={setPermissionsBusy}
                      onClose={() => setEditingCredential(null)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="agents-activity">
        <header className={own.head}>
          <h3 id="agents-activity">
            {t("activity.title")}
            {data.activity.length ? (
              <span className="ms-badge ms-badge-neutral ms-mono">{data.activity.length}</span>
            ) : null}
          </h3>
          {data.activity.length > 8 ? (
            <button
              type="button"
              className="ms-btn ms-btn-secondary ms-btn-sm"
              onClick={() => setShowAllActivity((v) => !v)}
            >
              {showAllActivity
                ? t("activity.showRecent")
                : t("activity.showAll", { count: data.activity.length })}
            </button>
          ) : null}
        </header>
        {!data.activity.length ? (
          <p className={styles.hint}>{t("activity.empty")}</p>
        ) : (
          <ol className={own.timeline}>
            {visibleActivity.map((event) => (
              <li key={event.id}>
                <time dateTime={new Date(event.createdAt).toISOString()}>
                  {when(event.createdAt)}
                </time>
                <span>
                  <strong>{event.agentLabel ?? tActivity("actors.agent")}</strong>{" "}
                  {tActivity(ACTIVITY_ACTION_KEYS[event.action])}
                  {event.count !== undefined
                    ? ` · ${tActivity("messageCount", { count: event.count })}`
                    : ""}
                </span>
                <small>{event.address}</small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
