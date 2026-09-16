"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect } from "react";
import { BtnSpinner } from "@/components/spinner";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { useCountdown } from "@/lib/use-countdown";

/** The console's Teams list, searched down to this team (the search matches an id). */
export function consoleTeamHref(teamId: string): string {
  return `/console/teams?q=${encodeURIComponent(teamId)}`;
}

/**
 * The strip over a dashboard opened in a support view: which team, that it
 * is read-only, and how long is left. Ending clears the grant and returns
 * to the console; the countdown running out reloads, and the server, which
 * has already ended the grant, lands the operator back on their own team.
 */
export function SupportViewBanner({
  teamId,
  teamName,
  expiresAt,
}: {
  teamId: string;
  teamName: string;
  expiresAt: Date;
}) {
  const t = useTranslations("common.supportView");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const back = consoleTeamHref(teamId);
  const leave = useCallback(() => window.location.assign(back), [back]);
  const left = useCountdown(expiresAt, leave);
  const end = useMutation(trpc.support.end.mutationOptions({ onSuccess: leave }));

  // Every refused mutation, from any screen, says why in one place.
  useEffect(() => {
    const readOnly = t("readOnly");
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      const error = event.action.error as { message?: string };
      if (trpcErrorCode(error) === "FORBIDDEN" && error.message === "Read-only support view") {
        toast(readOnly, "danger");
      }
    });
  }, [queryClient, t]);

  return (
    <div
      role="status"
      className="ms-notice-strip ms-notice-strip-warn"
      style={{ margin: 0, borderRadius: 0, borderWidth: "0 0 1px" }}
    >
      <span>{t("banner", { team: teamName, left })}</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}>
        <Link href={back} className="ms-btn ms-btn-secondary">
          {t("back")}
        </Link>
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={end.isPending}
          onClick={() => end.mutate()}
        >
          <BtnSpinner on={end.isPending} />
          {t("end")}
        </button>
      </span>
    </div>
  );
}
