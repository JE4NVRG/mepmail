"use client";

import { useTranslations } from "next-intl";
import { openSupportChat } from "@/lib/support-chat";
import styles from "./support-launcher.module.css";

/** Floating "Support" on every dashboard page: opens the identified chat window. */
export function SupportLauncher() {
  const t = useTranslations("nav");
  return (
    <button
      type="button"
      className={styles.launcher}
      aria-label={t("supportChat")}
      title={t("supportChat")}
      onClick={() => openSupportChat()}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
      </svg>
      <span className={styles.label}>{t("support")}</span>
    </button>
  );
}
