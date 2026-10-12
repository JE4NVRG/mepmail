"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc";
import own from "./mailbox-agents-panel.module.css";

/**
 * The rail's "Aguardando aprovação · N": what agents asked this person to send, linking
 * to the agents panel. Nothing shows while nothing waits.
 */
export function MailboxAgentsPending() {
  const t = useTranslations("mailboxes-agent.panel");
  const trpc = useTRPC();
  const pending = useQuery(
    trpc.mailboxAgents.pending.queryOptions(undefined, { refetchInterval: 60_000, retry: false }),
  );
  const count = pending.data?.count ?? 0;
  if (!count) return null;
  return (
    <Link href="/mail/settings?tab=agents" className={own.pending}>
      <span>{t("approvals.title")}</span>
      <span className={own.count}>{count}</span>
    </Link>
  );
}
