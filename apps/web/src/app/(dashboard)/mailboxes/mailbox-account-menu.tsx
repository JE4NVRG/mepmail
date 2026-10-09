"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/popover-menu";
import { UserAvatar } from "@/components/user-avatar";
import { authClient } from "@/lib/auth-client";
import { isDesktop } from "@/lib/desktop-bridge";
import { isAppLocale, LOCALES, setLocaleCookie } from "@/lib/locale-cookie";
import type { CorreioPrefs } from "@/lib/mailbox-preferences";
import { MailboxFolderIcon } from "./mailbox-folder-icon";
import styles from "./mailboxes.module.css";

const THEMES = [
  { value: "system", icon: "monitor", label: "themeSystem" },
  { value: "light", icon: "sun", label: "themeLight" },
  { value: "dark", icon: "moon", label: "themeDark" },
] as const;

/**
 * The account menu on the Correio bar: the theme (system, light or dark, saved
 * to the person's preferences), the language, shortcuts, preferences, support,
 * the way back to the dashboard (not in the desktop app) and signing out.
 */
export function MailboxAccountMenu({
  theme,
  setTheme,
  onShortcuts,
  onPreferences,
}: {
  theme: CorreioPrefs["theme"];
  setTheme: (theme: CorreioPrefs["theme"]) => void;
  onShortcuts: () => void;
  onPreferences: () => void;
}) {
  const t = useTranslations("mailboxes");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss([panel, trigger], open, () => setOpen(false));
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (open)
      panel.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
  }, [open]);
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus({ preventScroll: true });
  }
  async function signOut() {
    await authClient.signOut();
    // Private query cache must not survive a change of authenticated account.
    window.location.assign("/login");
  }
  const email = session?.user.email;

  return (
    <div className={styles.accountMenu}>
      <button
        ref={trigger}
        type="button"
        className={styles.accountTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("account.menu")}
        title={email ?? t("account.menu")}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar {...(email ? { email } : {})} size={26} />
      </button>
      {open ? (
        <div
          ref={panel}
          role="menu"
          aria-label={t("account.menu")}
          className={`ms-menu ${styles.accountPanel}`}
          onKeyDown={onKeyDown}
        >
          {session?.user ? (
            <div className={styles.accountWho}>
              <strong>{session.user.name || email}</strong>
              {session.user.name ? <small>{email}</small> : null}
            </div>
          ) : null}
          <hr className="ms-menu-sep" />
          <div className="ms-menu-item static">
            {tCommon("accountMenu.appearance")}
            <span className="ms-theme-toggle">
              {THEMES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={theme === option.value ? "active" : undefined}
                  aria-label={t(`appearance.${option.label}`)}
                  title={t(`appearance.${option.label}`)}
                  aria-pressed={theme === option.value}
                  onClick={() => setTheme(option.value)}
                >
                  <MailboxFolderIcon name={option.icon} size={11} />
                </button>
              ))}
            </span>
          </div>
          <div className="ms-menu-item static">
            {tCommon("accountMenu.language")}
            <span className="ms-theme-toggle">
              {LOCALES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={locale === value ? "active wide" : "wide"}
                  aria-label={tCommon(`accountMenu.language_${value === "en" ? "en" : "ptBR"}`)}
                  aria-pressed={locale === value}
                  onClick={() => {
                    if (locale === value || !isAppLocale(value)) return;
                    setLocaleCookie(value);
                    router.refresh();
                  }}
                >
                  {value === "en" ? "EN" : "PT"}
                </button>
              ))}
            </span>
          </div>
          <hr className="ms-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => {
              close();
              onShortcuts();
            }}
          >
            {t("shortcuts.title")}
            <span className="ms-keycap">?</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => {
              close();
              onPreferences();
            }}
          >
            {t("account.preferences")}
          </button>
          {/* A new tab keeps the inbox open; /support#chat opens the support chat. */}
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => {
              setOpen(false);
              window.open("/support#chat", "_blank", "noopener,noreferrer");
            }}
          >
            {t("app.support")}
            <span aria-hidden="true">↗</span>
          </button>
          {isDesktop() ? null : (
            <Link
              role="menuitem"
              className="ms-menu-item"
              href="/emails"
              onClick={() => setOpen(false)}
            >
              {t("app.back")}
            </Link>
          )}
          <hr className="ms-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => void signOut()}
          >
            {tCommon("signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
