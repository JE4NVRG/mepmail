"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { canPromptInstall, type PhoneAppPlatform, promptInstall } from "@/lib/phone-app";
import styles from "./mailboxes.module.css";

/**
 * "App no celular": how to put the Correio on the home screen, no store needed. On
 * Android with the browser's prompt available, one button installs it; otherwise (and
 * always on the iPhone) the steps in the phone's own browser.
 */
export function MailboxPhoneAppDialog({
  platform,
  close,
}: {
  platform: PhoneAppPlatform;
  close: () => void;
}) {
  const t = useTranslations("mailboxes.app.phone");
  const common = useTranslations("mailboxes");
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    setPrompt(platform === "android" && canPromptInstall());
  }, [platform]);
  const steps =
    platform === "ios" ? ["ios1", "ios2", "ios3"] : ["android1", "android2", "android3"];
  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} onClose={close}>
      <header className={styles.dialogHeader}>
        <h2 id={`${id}-title`}>{t("title")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={common("close")}
          onClick={close}
        >
          ×
        </button>
      </header>
      <p className={styles.hint}>{t("intro")}</p>
      {prompt ? (
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          onClick={async () => {
            if (await promptInstall()) close();
            else setPrompt(false);
          }}
        >
          {t("install")}
        </button>
      ) : (
        <ol className={styles.phoneSteps}>
          {steps.map((step) => (
            <li key={step}>{t(step)}</li>
          ))}
        </ol>
      )}
      <p className={styles.hint}>{t("note")}</p>
      <footer className={styles.dialogFooter}>
        <button type="button" className="ms-btn" onClick={close}>
          {t("done")}
        </button>
      </footer>
    </dialog>
  );
}
