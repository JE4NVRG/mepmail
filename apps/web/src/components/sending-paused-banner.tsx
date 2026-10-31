"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { sendingClarityMessage } from "@/lib/sending-clarity";
import { useTRPC } from "@/lib/trpc";

/**
 * Team-scoped advisory, never a grant of admission or automatic replay.
 * Other routes retain all live server checks; no policy is exposed to the client.
 */
export function SendingPausedBanner() {
  const t = useTranslations("common");
  const trpc = useTRPC();
  const { data } = useQuery(
    trpc.system.sendingAvailability.queryOptions(undefined, { staleTime: 60_000 }),
  );
  if (!data || data.state === "normal") return null;
  return (
    <NoticeStrip
      tone="warn"
      text={sendingClarityMessage(
        t,
        data.state === "limited" ? "sendingPaused.limitedText" : "sendingPaused.scopeText",
      )}
    />
  );
}
