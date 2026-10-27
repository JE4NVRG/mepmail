"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
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
}: {
  /** "Conectar agente" (the mailbox's own dialog, opened by the Correio). */
  onConnect?: () => void;
}) {
  const t = useTranslations("mailboxes-agent.panel");
  const tAgent = useTranslations("mailboxes-agent");
  const tActivity = useTranslations("mailboxes-activity");
  const locale = useLocale();
  const panelId = useId();
  const panel = useRef<HTMLElement>(null);
  const previousConfirmation = useRef<string | null>(null);
  const router = useRouter();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const overview = useQuery(
    trpc.mailboxAgents.overview.queryOptions(undefined, {
      refetchInterval: 60_000,
    }),
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
  useEffect(() => {
    if (confirming) {
      panel.current?.querySelector<HTMLElement>("[data-confirmation]")?.focus();
    } else if (previousConfirmation.current) {
      const action = previousConfirmation.current;
      Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[data-confirm-action]") ?? [])
        .find((button) => button.dataset.confirmAction === action)
        ?.focus();
    }
    previousConfirmation.current = confirming;
  }, [confirming]);
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
    new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  const refresh = () =>
    queries.invalidateQueries({
      queryKey: trpc.mailboxAgents.overview.queryKey(),
    });
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

  if (overview.isPending)
    return (
      <p className={styles.hint} role="status">
        {t("loading")}
      </p>
    );
  if (overview.isError || !data)
    return (
      <div role="alert">
        <p>{t("error")}</p>
        <button type="button" className="ms-btn" onClick={() => void overview.refetch()}>
          {t("retry")}
        </button>
      </div>
    );

  return (
    <section
      className={own.panel}
      aria-label={tAgent("title")}
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === "Escape" && confirming && !busy) {
          event.preventDefault();
          event.stopPropagation();
          setConfirming(null);
        }
      }}
    >
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
                  <p className={own.approvalState}>{t("approvals.title")}</p>
                  <strong className={own.address} id={`${panelId}-${item.itemId}-mailbox`}>
                    {item.address}
                  </strong>
                  <p className={own.meta}>
                    {t("approvals.asked", {
                      agent: item.agentLabel ?? tActivity("actors.agent"),
                      mailbox: item.address,
                      date: when(item.requestedAt),
                    })}
                  </p>
                  <strong className={own.subject} id={`${panelId}-${item.itemId}-subject`}>
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
                    <fieldset
                      className={own.actions}
                      data-confirmation
                      tabIndex={-1}
                      aria-labelledby={`${panelId}-${item.itemId}-mailbox ${panelId}-${item.itemId}-subject`}
                    >
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
                    </fieldset>
                  ) : confirming === `discard:${item.itemId}` ? (
                    <fieldset
                      className={own.actions}
                      data-confirmation
                      tabIndex={-1}
                      aria-labelledby={`${panelId}-${item.itemId}-mailbox ${panelId}-${item.itemId}-subject`}
                    >
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
                    </fieldset>
                  ) : (
                    <div className={own.actions}>
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary ms-btn-sm"
                        disabled={busy || !recipients}
                        data-confirm-action={key}
                        aria-describedby={`${panelId}-${item.itemId}-mailbox ${panelId}-${item.itemId}-subject`}
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
                        data-confirm-action={`discard:${item.itemId}`}
                        aria-describedby={`${panelId}-${item.itemId}-mailbox ${panelId}-${item.itemId}-subject`}
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
          <h3 id="agents-connected">{t("agents.title")}</h3>
          {onConnect ? (
            <button type="button" className="ms-btn ms-btn-sm" onClick={onConnect}>
              {t("agents.connect")}
            </button>
          ) : null}
        </header>
        {!data.credentials.length ? (
          <p className={styles.hint}>{t("agents.empty")}</p>
        ) : (
          <ul className={own.list}>
            {data.credentials.map((agent) => {
              const key = `revoke:${agent.credentialId}`;
              return (
                <li
                  key={agent.credentialId}
                  aria-labelledby={`${panelId}-${agent.credentialId}-agent`}
                >
                  <div className={own.agent}>
                    <strong id={`${panelId}-${agent.credentialId}-agent`}>{agent.label}</strong>
                    <span className={own.tags}>
                      <span className={own.tag}>{t(`agents.kind.${agent.kind}`)}</span>
                    </span>
                    <dl className={own.mailboxes} id={`${panelId}-${agent.credentialId}-mailboxes`}>
                      <dt>{tAgent("team.mailboxes")}</dt>
                      <dd>
                        {agent.mailboxes.map((mailbox) => {
                          const scopes =
                            mailbox.scopes ?? (agent.kind === "mailbox" ? agent.scopes : []);
                          return (
                            <div key={mailbox.mailboxId} className={own.mailbox}>
                              <strong>{mailbox.address}</strong>
                              <span className={own.tags}>
                                {scopes.map((scope) => (
                                  <span key={scope} className={own.tag}>
                                    {scope === "send"
                                      ? tAgent("perMailbox.send")
                                      : t(`agents.scope.${scope}`)}
                                  </span>
                                ))}
                              </span>
                              {scopes.includes("draft") && !scopes.includes("send") ? (
                                <span className={own.meta}>{t("agents.asksYou")}</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </dd>
                    </dl>
                    <small>
                      {agent.lastUsedAt
                        ? t("agents.used", { date: when(agent.lastUsedAt) })
                        : t("agents.unused")}
                      {agent.lastSentAt
                        ? ` · ${t("agents.sent", { date: when(agent.lastSentAt) })}`
                        : ""}
                      {agent.kind !== "mailbox" ? ` · ${tAgent("perMailbox.summary")}` : ""}
                    </small>
                  </div>
                  {confirming === key ? (
                    <fieldset
                      className={own.actions}
                      data-confirmation
                      tabIndex={-1}
                      aria-labelledby={`${panelId}-${agent.credentialId}-agent`}
                      aria-describedby={`${panelId}-${agent.credentialId}-mailboxes`}
                    >
                      <span>
                        {t("agents.revokeConfirm", {
                          count: agent.mailboxes.length,
                        })}
                      </span>
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
                            if (agent.kind === "mailbox")
                              await revokeKey.mutateAsync({
                                mailboxId: agent.mailboxes[0]!.mailboxId,
                                id: agent.credentialId,
                              });
                            else
                              await revokeCredential.mutateAsync({
                                id: agent.credentialId,
                              });
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
                    </fieldset>
                  ) : (
                    <div className={own.actions}>
                      {agent.kind !== "mailbox" ? (
                        <button
                          type="button"
                          className="ms-btn ms-btn-sm"
                          disabled={busy}
                          aria-label={tAgent("perMailbox.editLabel", {
                            label: agent.label,
                          })}
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
                        className="ms-btn ms-btn-ghost ms-btn-sm"
                        disabled={busy}
                        data-confirm-action={key}
                        aria-label={tAgent("revokeLabel", {
                          label: agent.label,
                        })}
                        aria-describedby={`${panelId}-${agent.credentialId}-mailboxes`}
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
          <h3 id="agents-activity">{t("activity.title")}</h3>
        </header>
        {!data.activity.length ? (
          <p className={styles.hint}>{t("activity.empty")}</p>
        ) : (
          <ol className={own.timeline}>
            {data.activity.map((event) => (
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
    </section>
  );
}
