"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Select } from "@/components/select";
import { Switch } from "@/components/switch";
import { isDesktop } from "@/lib/desktop-bridge";
import type { CorreioPrefs } from "@/lib/mailbox-preferences";
import styles from "./mailboxes.module.css";

const START_FOLDERS = ["inbox", "favorites", "drafts", "sent", "archive", "trash"] as const;

/**
 * The "Aparência" tab: every personal preference of the inbox in one place,
 * saved to the person's account as it changes, so the desktop shell, the web
 * and the phone all look the same.
 */
export function MailboxAppearanceSettings({
  prefs,
  setPref,
  resetPrefs,
  openShortcuts,
}: {
  prefs: CorreioPrefs;
  setPref: (patch: Partial<CorreioPrefs>) => void;
  resetPrefs: () => void;
  openShortcuts: () => void;
}) {
  const t = useTranslations("mailboxes.appearance");
  const common = useTranslations("mailboxes");
  const id = useId();
  const desktop = isDesktop();

  function cards<K extends "theme" | "density" | "readingPane">(
    key: K,
    choices: { value: CorreioPrefs[K]; label: string; sub?: string }[],
  ) {
    return (
      <div className={styles.appearanceCards} role="radiogroup" aria-labelledby={`${id}-${key}`}>
        {choices.map((choice) => (
          <label key={String(choice.value)} className="ms-radio-card">
            <input
              type="radio"
              name={`${id}-${key}`}
              value={String(choice.value)}
              checked={prefs[key] === choice.value}
              onChange={() => setPref({ [key]: choice.value } as Partial<CorreioPrefs>)}
            />
            <span>
              {choice.label}
              {choice.sub ? <span className="sub">{choice.sub}</span> : null}
            </span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.appearance}>
      <p className={styles.hint}>{t("hint")}</p>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-theme`}>
        <h3 id={`${id}-theme`}>{t("theme")}</h3>
        {cards("theme", [
          { value: "system", label: t("themeSystem") },
          { value: "light", label: t("themeLight") },
          { value: "dark", label: t("themeDark") },
        ])}
        {desktop ? <p className={styles.hint}>{t("themeDesktopNote")}</p> : null}
      </section>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-density`}>
        <h3 id={`${id}-density`}>{t("density")}</h3>
        {cards("density", [
          { value: "comfortable", label: common("view.comfortable") },
          { value: "compact", label: common("view.compact") },
        ])}
      </section>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-readingPane`}>
        <h3 id={`${id}-readingPane`}>{t("readingPane")}</h3>
        {cards("readingPane", [
          { value: "right", label: common("view.paneRight") },
          { value: "bottom", label: common("view.paneBottom") },
          { value: "off", label: common("view.paneOff") },
        ])}
      </section>

      <section className={styles.appearanceGroup}>
        <div className={styles.appearanceRow}>
          <label htmlFor={`${id}-preview`}>{t("previewLines")}</label>
          <Select
            id={`${id}-preview`}
            ariaLabel={t("previewLines")}
            value={String(prefs.previewLines)}
            width={220}
            onChange={(value) =>
              setPref({ previewLines: Number(value) as CorreioPrefs["previewLines"] })
            }
            options={[
              { value: "0", label: common("view.previewNone") },
              { value: "1", label: common("view.previewOne") },
              { value: "2", label: common("view.previewTwo") },
            ]}
          />
        </div>
        <div className={styles.appearanceRow}>
          <label htmlFor={`${id}-markSeen`}>{t("markSeen")}</label>
          <Select
            id={`${id}-markSeen`}
            ariaLabel={t("markSeen")}
            value={prefs.markSeenAfterMs === null ? "manual" : String(prefs.markSeenAfterMs)}
            width={220}
            onChange={(value) =>
              setPref({
                markSeenAfterMs:
                  value === "manual" ? null : (Number(value) as CorreioPrefs["markSeenAfterMs"]),
              })
            }
            options={[
              { value: "0", label: t("markSeenOpen") },
              { value: "1500", label: t("markSeenAfter", { seconds: 1.5 }) },
              { value: "3000", label: t("markSeenAfter", { seconds: 3 }) },
              { value: "manual", label: t("markSeenManual") },
            ]}
          />
        </div>
        <div className={styles.appearanceRow}>
          <label htmlFor={`${id}-start`}>{t("startFolder")}</label>
          <Select
            id={`${id}-start`}
            ariaLabel={t("startFolder")}
            value={
              START_FOLDERS.includes(prefs.startFolder as (typeof START_FOLDERS)[number])
                ? prefs.startFolder
                : "inbox"
            }
            width={220}
            onChange={(value) => setPref({ startFolder: value as CorreioPrefs["startFolder"] })}
            options={START_FOLDERS.map((folder) => ({ value: folder, label: common(folder) }))}
          />
        </div>
        <div className={styles.appearanceRow}>
          <span id={`${id}-avatars`}>{common("view.showAvatars")}</span>
          <Switch
            checked={prefs.showAvatars}
            disabled={false}
            ariaLabel={common("view.showAvatars")}
            onChange={(checked) => setPref({ showAvatars: checked })}
          />
        </div>
        <div className={styles.appearanceRow}>
          <span id={`${id}-hints`}>{t("shortcutHints")}</span>
          <Switch
            checked={prefs.showShortcutHints}
            disabled={false}
            ariaLabel={t("shortcutHints")}
            onChange={(checked) => setPref({ showShortcutHints: checked })}
          />
        </div>
      </section>

      <div className={styles.appearanceActions}>
        <button type="button" className="ms-btn ms-btn-ghost" onClick={openShortcuts}>
          {t("viewShortcuts")}
        </button>
        <button type="button" className="ms-btn ms-btn-ghost" onClick={resetPrefs}>
          {t("restoreDefaults")}
        </button>
      </div>
    </div>
  );
}
