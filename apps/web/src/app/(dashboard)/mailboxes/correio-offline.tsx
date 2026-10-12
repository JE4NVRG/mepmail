"use client";

import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { Switch } from "@/components/switch";
import {
  clearCorreioOffline,
  correioOfflineWanted,
  restoreCorreioOffline,
  saveCorreioOffline,
  setCorreioOfflineSwitch,
  startCorreioOffline,
} from "@/lib/correio-offline";
import { isDesktop } from "@/lib/desktop-bridge";
import { useTRPC } from "@/lib/trpc";
import own from "./correio-offline.module.css";
import styles from "./mailboxes.module.css";

/** Saving waits for the cache to settle this long after a change. */
const SAVE_EVERY_MS = 15_000;
/** Newest inbox messages read ahead, so they open without internet too. */
const READ_AHEAD = 30;
const READ_AHEAD_GAP_MS = 250;

/**
 * Reading without internet in the desktop app (lib/correio-offline.ts). Mounted once
 * in the Correio: it registers the page copy, puts the saved mail back for this person,
 * keeps saving what the Correio shows, reads the newest inbox messages ahead and shows
 * "Sem conexão" with the time of the copy while the network is gone. Elsewhere (a
 * browser, the switch off) it does nothing.
 */
export function CorreioOffline({
  userId,
  scope = "/mail",
}: {
  userId: string | null;
  /** The pages the copy covers (the QA harness uses its own). */
  scope?: string;
}) {
  const t = useTranslations("mailboxes-offline");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);
  const [online, setOnline] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const readingAhead = useRef(false);

  useEffect(() => {
    setOnline(navigator.onLine);
    // Opened without network: queries wait for it instead of failing (the copy shows).
    if (correioOfflineWanted()) onlineManager.setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (!correioOfflineWanted()) return;
    // Without network the session cannot be read: the last user's copy opens. Online,
    // wait for the person so that another account never sees it.
    if (!userId && navigator.onLine) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void startCorreioOffline(scope);
    void restoreCorreioOffline(queryClient, userId)
      .then((at) => {
        if (!stopped && at) setSavedAt(at);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) setActive(true);
      });
    const save = () => {
      timer = null;
      if (stopped || !navigator.onLine || !userId) return;
      void saveCorreioOffline(queryClient, userId).then(
        (at) => !stopped && setSavedAt(at),
        () => undefined,
      );
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || timer) return;
      timer = setTimeout(save, SAVE_EVERY_MS);
    });
    // Hidden (minimised to the tray, another window): save what is there now.
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      if (timer) clearTimeout(timer);
      save();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      stopped = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", hidden);
      if (timer) clearTimeout(timer);
    };
  }, [queryClient, userId, scope]);

  // The newest inbox messages, read ahead once per session while online.
  useEffect(() => {
    if (!active || !online || readingAhead.current) return;
    readingAhead.current = true;
    let stopped = false;
    const run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const inbox = queryClient.getQueryData<{
        pages: { items: { id: string; mailboxId: string }[] }[];
      }>(
        trpc.mailboxes.items.infiniteQueryKey({
          mailboxId: null,
          folder: "inbox",
          mailboxKind: undefined,
        }),
      );
      const newest = (inbox?.pages[0]?.items ?? []).slice(0, READ_AHEAD);
      for (const item of newest) {
        if (stopped || !navigator.onLine) return;
        const options = trpc.mailboxes.item.queryOptions({
          mailboxId: item.mailboxId,
          id: item.id,
        });
        if (queryClient.getQueryData(options.queryKey)) continue;
        await queryClient.prefetchQuery({ ...options, retry: false }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, READ_AHEAD_GAP_MS));
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [active, online, queryClient, trpc]);

  if (!active || online) return null;
  return (
    <div className={own.banner} role="status">
      <span className={own.dot} aria-hidden="true" />
      {savedAt
        ? t("banner", {
            time: new Intl.DateTimeFormat(locale, {
              dateStyle: "short",
              timeStyle: "short",
            }).format(savedAt),
          })
        : t("bannerNoCopy")}
    </div>
  );
}

/** Preferências → "Ler sem internet" (desktop app only): on by default; off deletes the copy. */
export function CorreioOfflineSetting() {
  const t = useTranslations("mailboxes-offline");
  const id = useId();
  const [shown, setShown] = useState(false);
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setShown(isDesktop());
    setOn(correioOfflineWanted());
  }, []);
  if (!shown) return null;
  return (
    <section className={styles.appearanceGroup} aria-labelledby={`${id}-offline`}>
      <h3 id={`${id}-offline`}>{t("title")}</h3>
      <div className={styles.appearanceRow}>
        <span>{t("switch")}</span>
        <Switch
          checked={on}
          disabled={busy}
          ariaLabel={t("switch")}
          onChange={async (checked) => {
            setBusy(true);
            setCorreioOfflineSwitch(checked);
            setOn(checked);
            if (checked) await startCorreioOffline();
            else await clearCorreioOffline();
            setBusy(false);
          }}
        />
      </div>
      <p className={styles.hint}>{t(on ? "hintOn" : "hintOff")}</p>
    </section>
  );
}
