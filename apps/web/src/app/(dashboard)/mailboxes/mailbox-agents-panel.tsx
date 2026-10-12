"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { ACTIVITY_ACTION_KEYS } from "./mailbox-activity";
import own from "./mailbox-agents-panel.module.css";
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
  const busy =
    send.isPending || discard.isPending || revokeKey.isPending || revokeCredential.isPending;
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

  return (
    <div className={own.panel}>
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
                            failed(cause);
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
                <li key={agent.credentialId}>
                  <div className={own.agent}>
                    <strong>{agent.label}</strong>
                    <span className={own.tags}>
                      <span className={own.tag}>{t(`agents.kind.${agent.kind}`)}</span>
                      {agent.scopes.map((scope) => (
                        <span key={scope} className={own.tag}>
                          {t(`agents.scope.${scope}`)}
                        </span>
                      ))}
                    </span>
                    <small>{agent.mailboxes.map((m) => m.address).join(", ")}</small>
                    <small>
                      {agent.lastUsedAt
                        ? t("agents.used", { date: when(agent.lastUsedAt) })
                        : t("agents.unused")}
                      {agent.lastSentAt
                        ? ` · ${t("agents.sent", { date: when(agent.lastSentAt) })}`
                        : ""}
                      {` · ${t(agent.scopes.includes("send") ? "agents.sendsAlone" : "agents.asksYou")}`}
                    </small>
                  </div>
                  {confirming === key ? (
                    <div className={own.actions}>
                      <span>{t("agents.revokeConfirm", { count: agent.mailboxes.length })}</span>
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
                    <button
                      type="button"
                      className="ms-btn ms-btn-ghost ms-btn-sm"
                      disabled={busy}
                      onClick={() => setConfirming(key)}
                    >
                      {t("agents.revoke")}
                    </button>
                  )}
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
    </div>
  );
}
