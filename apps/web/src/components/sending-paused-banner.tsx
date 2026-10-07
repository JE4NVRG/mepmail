"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { useTRPC } from "@/lib/trpc";

/**
 * Shown on every dashboard page while SES has paused sending: mail keeps
 * being accepted and waits in the queue, then goes out on its own.
 */
export function SendingPausedBanner() {
  const t = useTranslations("common.sendingPaused");
  const trpc = useTRPC();
  const { data } = useQuery(trpc.system.sendingPaused.queryOptions(undefined, { staleTime: 60_000 }));
  if (!data) return null;
  return <NoticeStrip tone="warn" text={t("text")} />;
}
