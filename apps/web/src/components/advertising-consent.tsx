"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { adConsent } from "@/lib/ad-consent";
import {
  createMetaPublicController,
  guardMetaNavigation,
  loadManualMetaSdk,
  META_ORIGIN,
  META_PIXEL_ID,
} from "@/lib/meta-public-events";
import styles from "./advertising-consent.module.css";

const configured =
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_META_PIXEL_ENABLED === "true" &&
  process.env.NEXT_PUBLIC_META_PIXEL_ID === META_PIXEL_ID;
let controller: ReturnType<typeof createMetaPublicController> | undefined;
const SETTINGS_EVENT = "mepmail:advertising-settings";

function publicDocument(pathname = window.location.pathname) {
  return window.location.origin === META_ORIGIN && ["/", "/pricing"].includes(pathname);
}

/** The settings leaf can be reused in public chrome without making it a client tree. */
export function AdvertisingSettingsButton() {
  const t = useTranslations("common.advertising");
  return (
    <button
      type="button"
      className={styles.settings}
      onClick={() => {
        window.dispatchEvent(new Event(SETTINGS_EVENT));
      }}
    >
      {t("settings")}
    </button>
  );
}

export function AdvertisingConsent() {
  const t = useTranslations("common.advertising");
  const pathname = usePathname();
  const consent = useSyncExternalStore(
    adConsent.subscribe,
    adConsent.getSnapshot,
    adConsent.getServerSnapshot,
  );
  const [open, setOpen] = useState(false);
  const [publicPage, setPublicPage] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    setPublicPage(configured && publicDocument());
    if (!configured) return;
    const settings = () => {
      setOpen(true);
      void adConsent.read();
    };
    window.addEventListener(SETTINGS_EVENT, settings);
    if (typeof BroadcastChannel !== "undefined") {
      const messages = new BroadcastChannel("mepmail-advertising-consent");
      channel.current = messages;
      // Broadcast is a revoke signal, never an acceptance authority.
      messages.onmessage = (event) => {
        if (event.data === "withdraw") adConsent.blockLocally();
      };
    }
    // The singleton survives React StrictMode's effect replay and avoids duplicate events.
    controller ??= createMetaPublicController({
      href: () => window.location.href,
      referrer: () => document.referrer,
      consent: () => adConsent.getSnapshot().state,
      load: () => loadManualMetaSdk(window, document),
      leaveDocument: (href) => window.location.assign(href),
      watchPlans: (callback) => {
        const plans = document.getElementById("planos");
        if (!plans || typeof IntersectionObserver === "undefined") return () => {};
        const observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) callback();
          },
          { threshold: 0.25 },
        );
        observer.observe(plans);
        return () => observer.disconnect();
      },
    });
    const active = controller;
    const unsubscribe = adConsent.subscribe(active.reconcile);
    const stopNavigation = guardMetaNavigation(window, document, active);
    const recheck = () => {
      if (document.visibilityState === "visible") void adConsent.read();
    };
    document.addEventListener("visibilitychange", recheck);
    if (publicDocument()) void adConsent.read();
    active.reconcile();
    return () => {
      window.removeEventListener(SETTINGS_EVENT, settings);
      document.removeEventListener("visibilitychange", recheck);
      unsubscribe();
      stopNavigation();
      active.dispose();
      channel.current?.close();
      channel.current = null;
    };
  }, []);

  useEffect(() => {
    setPublicPage(configured && publicDocument(pathname));
    // Covers programmatic navigation in addition to the before-history/anchor guards.
    if (!controller?.beforeNavigation(window.location.href)) controller?.reconcile();
  }, [pathname]);

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);

  if (!configured) return null;
  const choose = async (granted: boolean) => {
    if (!granted) channel.current?.postMessage("withdraw");
    await adConsent.choose(granted);
    if (!adConsent.getSnapshot().error) setOpen(false);
  };
  const controls = (
    <div className={styles.actions}>
      <button className="ms-btn" type="button" onClick={() => void choose(false)}>
        {consent.state === "accepted" ? t("withdraw") : t("deny")}
      </button>
      <button
        className="ms-btn"
        type="button"
        disabled={consent.pending}
        onClick={() => void choose(true)}
      >
        {t("accept")}
      </button>
    </div>
  );
  const details = (
    <>
      <p>
        {t("body")} <a href="/privacy">{t("privacyLink")}</a>
      </p>
      <p aria-live="polite">
        {consent.pending
          ? t("pending")
          : consent.error
            ? t("error")
            : consent.state === "accepted"
              ? t("currentAccepted")
              : consent.state === "denied"
                ? t("currentDenied")
                : t("unknown")}
      </p>
      {controls}
    </>
  );
  return (
    <>
      {publicPage && (consent.state === "unknown" || consent.error) && !open ? (
        <aside className={styles.banner} aria-label={t("title")}>
          <h2>{t("title")}</h2>
          {details}
        </aside>
      ) : null}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="advertising-title"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <h2 id="advertising-title">{t("title")}</h2>
        {details}
        <button type="button" className={styles.settings} onClick={() => setOpen(false)}>
          {t("close")}
        </button>
      </dialog>
    </>
  );
}
