"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc";
import own from "./mailbox-agents-panel.module.css";

/**
 * The rail's AI team hub: surfaces autonomous agents (sending freely), dedicated agent
 * mailboxes, and any sends waiting for approval, linking straight to Agentes settings.
 */
export function MailboxAgentsPending({ agentBoxCount = 0 }: { agentBoxCount?: number }) {
  const t = useTranslations("mailboxes-agent.panel");
  const tRail = useTranslations("mailboxes.rail");
  const trpc = useTRPC();
  const pending = useQuery(
    trpc.mailboxAgents.pending.queryOptions(undefined, { refetchInterval: 60_000, retry: false }),
  );
  const overview = useQuery(
    trpc.mailboxAgents.overview.queryOptions(undefined, {
      staleTime: 60_000,
      refetchInterval: 60_000,
      retry: false,
    }),
  );
  const approvalsCount = overview.data?.approvals.length ?? pending.data?.count ?? 0;
  const autonomousCount =
    overview.data?.credentials.filter((c) => c.scopes.includes("send")).length ?? 0;
  const connectedCount = overview.data?.credentials.length ?? 0;
  if (!approvalsCount && !connectedCount && !agentBoxCount) return null;
  const parts = [
    autonomousCount > 0 ? tRail("teamAgentsAutonomous", { count: autonomousCount }) : null,
    agentBoxCount > 0 ? tRail("teamAgentsMailboxes", { count: agentBoxCount }) : null,
  ].filter(Boolean);
  return (
    <Link href="/mail/settings?tab=agents" className={own.pending}>
      <span className={own.pendingCopy}>
        <strong className={own.pendingTitle}>{tRail("teamAgents")}</strong>
        {parts.length ? <small className={own.pendingMeta}>{parts.join(" · ")}</small> : null}
      </span>
      {approvalsCount > 0 ? (
        <span className={own.count} title={t("approvals.title")}>
          {approvalsCount}
        </span>
      ) : null}
    </Link>
  );
}
