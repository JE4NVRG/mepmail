"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { adConsent } from "@/lib/ad-consent";
import { createGooglePublicController, loadGoogleTag } from "@/lib/google-public-events";
import {
  createMetaPublicController,
  guardMetaNavigation,
  loadManualMetaSdk,
  META_ORIGIN,
  META_PIXEL_ID,
  META_PUBLIC_PATHS,
} from "@/lib/meta-public-events";
import styles from "./advertising-consent.module.css";

const metaConfigured =
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PUBLIC_META_PIXEL_ENABLED === "true" &&
  process.env.NEXT_PUBLIC_META_PIXEL_ID === META_PIXEL_ID;
const googleConfigured =
  process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_GOOGLE_TAG_ENABLED === "true";
const configured = metaConfigured || googleConfigured;
interface PublicController {
  reconcile(): void;
  beforeNavigation(href: string): boolean;
  dispose(): void;
}
let controller: PublicController | undefined;
let leaving = false;
/** Both tags leave a public document the same way; the first caller navigates. */
function leaveDocument(href: string) {
  if (leaving) return;
  leaving = true;
  window.location.assign(href);
}

/** Meta and Google share one consent and one navigation guard; each decides for itself. */
function publicController(): PublicController {
  const port = {
    href: () => window.location.href,
    referrer: () => document.referrer,
    consent: () => adConsent.getSnapshot().state,
    leaveDocument,
  };
  const meta = metaConfigured
    ? createMetaPublicController({
        ...port,
        load: () => loadManualMetaSdk(window, document),
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
      })
    : undefined;
  const google = googleConfigured
    ? createGooglePublicController({ ...port, load: () => loadGoogleTag(window, document) })
    : undefined;
  return {
    reconcile() {
      meta?.reconcile();
      google?.reconcile();
    },
    beforeNavigation(href) {
      // Both run, Google first: its signup lead is queued before the document is left.
      const googleLeaves = google?.beforeNavigation(href) ?? false;
      const metaLeaves = meta?.beforeNavigation(href) ?? false;
      return googleLeaves || metaLeaves;
    },
    dispose() {
      meta?.dispose();
      google?.dispose();
    },
  };
}
const SETTINGS_EVENT = "mepmail:advertising-settings";

function publicDocument(pathname = window.location.pathname) {
  return window.location.origin === META_ORIGIN && META_PUBLIC_PATHS.has(pathname);
}

/** The settings leaf can be reused in public chrome without making it a client tree. */
export function AdvertisingSettingsButton() {
  const t = useTranslations("common.advertising");
  return (
    <button
      type="button"
      className={styles.settings}
      aria-haspopup="dialog"
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
    controller ??= publicController();
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
    const isPublic = configured && publicDocument(pathname);
    setPublicPage(isPublic);
    // A document reloaded on signup can return here with a fresh, unknown store.
    if (isPublic) void adConsent.read();
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
      <button
        className={`ms-btn ms-btn-secondary ${styles.choice}`}
        type="button"
        onClick={() => void choose(false)}
      >
        {consent.state === "accepted" ? t("withdraw") : t("deny")}
      </button>
      <button
        className={`ms-btn ms-btn-primary ${styles.choice}`}
        type="button"
        disabled={consent.pending}
        onClick={() => void choose(true)}
      >
        {t("accept")}
      </button>
    </div>
  );
  const heading = (id?: string) => (
    <div className={styles.heading}>
      <span className={styles.icon} aria-hidden="true">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M12 3 4.5 6v5.5c0 4.2 2.8 7.4 7.5 9.5 4.7-2.1 7.5-5.3 7.5-9.5V6L12 3Z" />
          <path d="m8.5 12 2.3 2.3 4.7-4.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <h2 id={id}>{t("title")}</h2>
    </div>
  );
  const details = (descriptionId?: string) => (
    <>
      <p className={styles.description} id={descriptionId}>
        {t("body")}
      </p>
      <a className={styles.policy} href="/privacy">
        {t("privacyLink")}
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor">
          <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
      <p
        className={styles.status}
        aria-live="polite"
        aria-atomic="true"
        data-state={consent.error ? "error" : consent.state}
      >
        <span className={styles.statusDot} aria-hidden="true" />
        <span>
          {consent.pending
            ? t("pending")
            : consent.error
              ? t("error")
              : consent.state === "accepted"
                ? t("currentAccepted")
                : consent.state === "denied"
                  ? t("currentDenied")
                  : t("unknown")}
        </span>
      </p>
      {controls}
    </>
  );
  return (
    <>
      {publicPage && (consent.state === "unknown" || consent.error) && !open ? (
        // First visit: one sentence and two equal choices; the full text and the
        // current state live in the settings dialog.
        <aside className={styles.banner} aria-label={t("title")}>
          <p className={styles.bannerText}>
            <strong>{t("bannerTitle")}</strong> {t("bannerBody")}{" "}
            <a className={styles.inlineLink} href="/privacy">
              {t("privacyShort")}
            </a>
          </p>
          {consent.error ? (
            <p className={styles.bannerError} role="status">
              {t("error")}
            </p>
          ) : null}
          {controls}
        </aside>
      ) : null}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="advertising-title"
        aria-describedby="advertising-description"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className={styles.dialogHeader}>
          {heading("advertising-title")}
          <button
            type="button"
            className={styles.close}
            aria-label={t("close")}
            onClick={() => setOpen(false)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor">
              <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {details("advertising-description")}
      </dialog>
    </>
  );
}
