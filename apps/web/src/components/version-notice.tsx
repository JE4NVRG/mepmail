"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { startVersionWatch } from "@/lib/version-watch";

/**
 * "A new version is available" once the server runs another release than the one this
 * page was rendered with. Reloading is the person's choice: a draft in progress is never
 * thrown away by the page itself.
 */
export function VersionNotice({ revision }: { revision: string | null }) {
  const t = useTranslations("common.versionNotice");
  const [served, setServed] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(
    () =>
      startVersionWatch(revision, setServed, {
        fetchRevision: async () => {
          const response = await fetch("/api/version", { cache: "no-store" });
          if (!response.ok) return null;
          const body = (await response.json()) as { revision?: unknown };
          return body.revision ?? null;
        },
        visible: () => document.visibilityState === "visible",
        now: () => Date.now(),
        onVisible: (listener) => {
          const onChange = () => {
            if (document.visibilityState === "visible") listener();
          };
          document.addEventListener("visibilitychange", onChange);
          window.addEventListener("focus", onChange);
          return () => {
            document.removeEventListener("visibilitychange", onChange);
            window.removeEventListener("focus", onChange);
          };
        },
        every: (ms, run) => {
          const timer = window.setInterval(run, ms);
          return () => window.clearInterval(timer);
        },
      }),
    [revision],
  );
  if (!served || dismissed === served) return null;
  return (
    <div role="status" className="ms-notice-strip ms-notice-strip-info ms-version-notice">
      <span>{t("text")}</span>
      <button
        type="button"
        className="ms-notice-strip-action ms-version-notice-action"
        onClick={() => window.location.reload()}
      >
        {t("reload")}
      </button>
      <button
        type="button"
        className="ms-version-notice-close"
        aria-label={t("dismiss")}
        onClick={() => setDismissed(served)}
      >
        ×
      </button>
    </div>
  );
}
