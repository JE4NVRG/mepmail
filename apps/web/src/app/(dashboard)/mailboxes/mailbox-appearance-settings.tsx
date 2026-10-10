"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Select } from "@/components/select";
import { Switch } from "@/components/switch";
import { isDesktop } from "@/lib/desktop-bridge";
import { isAppLocale, LOCALES, setLocaleCookie } from "@/lib/locale-cookie";
import { noticesWanted, writeNoticePreference } from "@/lib/mailbox-notifications";
import type { CorreioPrefs } from "@/lib/mailbox-preferences";
import {
  cleanQuickReplies,
  QUICK_REPLY_LIMITS,
  UNDO_SEND_CHOICES,
} from "@/lib/mailbox-quick-replies";
import styles from "./mailboxes.module.css";

const START_FOLDERS = ["inbox", "favorites", "drafts", "sent", "archive", "trash"] as const;

type GuideTab = "boxes" | "agents" | "migration";

/** The desktop app is Windows-only for now: offer it in a Windows browser. */
function offersWindowsApp() {
  return !isDesktop() && typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
}

type NoticeState = "on" | "off" | "blocked" | "unsupported";

/** This device's new-mail notices: a browser also needs its own permission. */
function readNoticeState(): NoticeState {
  if (isDesktop()) return noticesWanted(true) ? "on" : "off";
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return noticesWanted(false) && Notification.permission === "granted" ? "on" : "off";
}

/**
 * The "Preferências" tab: first steps, language, notifications and how the
 * inbox looks. Appearance choices are saved to the person's account as they
 * change, so the desktop app, the web and the phone look the same; language
 * and notices belong to this device.
 */
export function MailboxAppearanceSettings({
  prefs,
  setPref,
  resetPrefs,
  openShortcuts,
  openTab,
  senders,
}: {
  prefs: CorreioPrefs;
  setPref: (patch: Partial<CorreioPrefs>) => void;
  resetPrefs: () => void;
  openShortcuts: () => void;
  openTab: (tab: GuideTab) => void;
  /** "Remetentes aprovados e bloqueados", for a person who owns a mailbox. */
  senders?: ReactNode;
}) {
  const t = useTranslations("mailboxes.appearance");
  const common = useTranslations("mailboxes");
  const locale = useLocale();
  const router = useRouter();
  const id = useId();
  const desktop = isDesktop();
  const [notices, setNotices] = useState<NoticeState>("off");
  const [windowsApp, setWindowsApp] = useState(false);
  useEffect(() => {
    setNotices(readNoticeState());
    setWindowsApp(offersWindowsApp());
  }, []);

  // Quick replies are edited line by line and saved when a line loses focus.
  // What the account keeps replaces the lines whenever it changes (first
  // load, "Usar as sugeridas", another device, another language).
  const suggested = [
    common("quickReplies.default1"),
    common("quickReplies.default2"),
    common("quickReplies.default3"),
    common("quickReplies.default4"),
  ];
  const shownReplies = prefs.quickReplies ?? suggested;
  const storedReplies = `${locale}:${JSON.stringify(prefs.quickReplies)}`;
  const [replies, setReplies] = useState<string[]>(shownReplies);
  const [repliesFrom, setRepliesFrom] = useState(storedReplies);
  const [repliesError, setRepliesError] = useState(false);
  if (repliesFrom !== storedReplies) {
    setRepliesFrom(storedReplies);
    setReplies(shownReplies);
  }
  function commitReplies(list: string[]) {
    const clean = cleanQuickReplies(list);
    if (!clean) return setRepliesError(true);
    setRepliesError(false);
    if (JSON.stringify(clean) === JSON.stringify(shownReplies)) return;
    setPref({ quickReplies: clean });
  }

  async function changeNotices(on: boolean) {
    if (!on) {
      writeNoticePreference(false);
      setNotices("off");
      return;
    }
    if (!desktop) {
      if (typeof Notification === "undefined") return setNotices("unsupported");
      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== "granted") return setNotices(permission === "denied" ? "blocked" : "off");
    }
    writeNoticePreference(true);
    setNotices("on");
  }

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

  const guide: { key: string; label: string; run: () => void }[] = [
    { key: "receive", label: t("guideReceive"), run: () => openTab("boxes") },
    { key: "mailbox", label: t("guideMailbox"), run: () => openTab("boxes") },
    { key: "migrate", label: t("guideMigrate"), run: () => openTab("migration") },
    { key: "agent", label: t("guideAgent"), run: () => openTab("agents") },
    ...(windowsApp
      ? [
          {
            key: "windows",
            label: t("guideWindows"),
            run: () => window.location.assign("/desktop/correio/windows"),
          },
        ]
      : []),
    { key: "shortcuts", label: t("guideShortcuts"), run: openShortcuts },
  ];

  return (
    <div className={styles.appearance}>
      <section
        className={`${styles.appearanceGroup} ${styles.guide}`}
        aria-labelledby={`${id}-guide`}
      >
        <h3 id={`${id}-guide`}>{t("guideTitle")}</h3>
        <p className={styles.hint}>{t("guideHint")}</p>
        <ol className={styles.guideSteps}>
          {guide.map((step) => (
            <li key={step.key}>
              <button type="button" className={styles.guideStep} onClick={step.run}>
                <span>{step.label}</span>
                <span aria-hidden="true">→</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-language`}>
        <h3 id={`${id}-language`}>{t("language")}</h3>
        <div
          className={styles.appearanceCards}
          role="radiogroup"
          aria-labelledby={`${id}-language`}
        >
          {LOCALES.map((value) => (
            <label key={value} className="ms-radio-card">
              <input
                type="radio"
                name={`${id}-language`}
                value={value}
                checked={locale === value}
                onChange={() => {
                  if (locale === value || !isAppLocale(value)) return;
                  setLocaleCookie(value);
                  router.refresh();
                }}
              />
              <span>{value === "en" ? "English" : "Português (Brasil)"}</span>
            </label>
          ))}
        </div>
      </section>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-notices`}>
        <h3 id={`${id}-notices`}>{t("notifications")}</h3>
        <div className={styles.appearanceRow}>
          <span>{t("notifyNewMail")}</span>
          <Switch
            checked={notices === "on"}
            disabled={notices === "unsupported"}
            ariaLabel={t("notifyNewMail")}
            onChange={(checked) => void changeNotices(checked)}
          />
        </div>
        <p className={styles.hint}>
          {notices === "blocked"
            ? t("notifyBlocked")
            : notices === "unsupported"
              ? t("notifyUnsupported")
              : t(desktop ? "notifyDesktopHint" : "notifyBrowserHint")}
        </p>
      </section>

      <section className={styles.appearanceGroup} aria-labelledby={`${id}-sending`}>
        <h3 id={`${id}-sending`}>{t("sending")}</h3>
        <div className={styles.appearanceRow}>
          <label htmlFor={`${id}-undoSend`}>{t("undoSend")}</label>
          <Select
            id={`${id}-undoSend`}
            ariaLabel={t("undoSend")}
            value={String(prefs.undoSendSeconds)}
            width={220}
            onChange={(value) =>
              setPref({ undoSendSeconds: Number(value) as CorreioPrefs["undoSendSeconds"] })
            }
            options={UNDO_SEND_CHOICES.map((seconds) => ({
              value: String(seconds),
              label: seconds ? t("undoSendSeconds", { seconds }) : t("undoSendOff"),
            }))}
          />
        </div>
        <p className={styles.hint}>{t("undoSendHint")}</p>
        <h4 id={`${id}-quick`} className={styles.appearanceSubhead}>
          {t("quickReplies")}
        </h4>
        <p className={styles.hint}>{t("quickRepliesHint")}</p>
        <ul className={styles.quickReplyEditor} aria-labelledby={`${id}-quick`}>
          {replies.map((reply, index) => (
            // Lines have no identity of their own beyond their place in the list.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
            <li key={index}>
              <input
                className="ms-input"
                value={reply}
                maxLength={QUICK_REPLY_LIMITS.chars}
                placeholder={t("quickReplyPlaceholder")}
                aria-label={t("quickReplyLabel", { number: index + 1 })}
                onChange={(event) =>
                  setReplies((current) =>
                    current.map((value, at) => (at === index ? event.target.value : value)),
                  )
                }
                onBlur={(event) =>
                  commitReplies(
                    replies.map((value, at) => (at === index ? event.target.value : value)),
                  )
                }
              />
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                aria-label={t("quickReplyRemove")}
                title={t("quickReplyRemove")}
                onClick={() => {
                  const next = replies.filter((_, at) => at !== index);
                  setReplies(next);
                  commitReplies(next);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {repliesError ? (
          <p className={styles.hint} role="alert">
            {t("quickRepliesInvalid")}
          </p>
        ) : null}
        <div className={styles.quickReplyActions}>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            disabled={replies.length >= QUICK_REPLY_LIMITS.count}
            onClick={() => setReplies((current) => [...current, ""])}
          >
            {t("quickReplyAdd")}
          </button>
          {prefs.quickReplies !== null ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => {
                setRepliesError(false);
                setPref({ quickReplies: null });
              }}
            >
              {t("quickRepliesDefault")}
            </button>
          ) : null}
        </div>
      </section>

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
          <span id={`${id}-smart`}>{t("smartInbox")}</span>
          <Switch
            checked={prefs.smartInbox}
            disabled={false}
            ariaLabel={t("smartInbox")}
            onChange={(checked) => setPref({ smartInbox: checked })}
          />
        </div>
        <p className={styles.hint}>{t("smartInboxHint")}</p>
        <div className={styles.appearanceRow}>
          <span id={`${id}-senders`}>{t("askNewSenders")}</span>
          <Switch
            checked={prefs.askNewSenders}
            disabled={false}
            ariaLabel={t("askNewSenders")}
            onChange={(checked) => setPref({ askNewSenders: checked })}
          />
        </div>
        <p className={styles.hint}>{t("askNewSendersHint")}</p>
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

      {senders ? (
        <section className={styles.appearanceGroup} aria-labelledby={`${id}-senderList`}>
          <h3 id={`${id}-senderList`}>{common("senders.listTitle")}</h3>
          {senders}
        </section>
      ) : null}

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
