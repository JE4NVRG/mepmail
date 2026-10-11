"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useAppRelease } from "@/components/app-release";
import { useDismiss } from "@/components/popover-menu";
import { type DesktopInfo, desktopInfo } from "@/lib/desktop-bridge";
import { DOCS_URL } from "@/lib/docs-links";
import styles from "./mailbox-rail.module.css";

/** The support page opened on its chat (the dashboard sidebar links the same). */
const SUPPORT_CHAT = "/support#chat";
const PLATFORMS: Record<string, string> = { windows: "Windows", linux: "Linux", macos: "macOS" };

/**
 * The rail's last tool: the running version where the "?" used to be (the "?"
 * itself while the rail shows icons only). It opens what to know about this
 * Correio: version and date, the desktop app's own version when inside it,
 * what is new, the keyboard shortcuts (still also on "?"), the help center
 * and support.
 */
export function MailboxHelpMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const t = useTranslations("mailboxes.help");
  const locale = useLocale();
  const release = useAppRelease();
  const id = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss([panel, trigger], open, () => setOpen(false));
  // The shell marks the page on load; read it after hydration so server and client agree.
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  useEffect(() => setDesktop(desktopInfo()), []);

  const version = release.version;
  const date = release.date
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${release.date}T12:00:00Z`))
    : null;
  const label = version ? t("label", { version }) : t("title");
  const close = () => setOpen(false);

  return (
    <div className={styles.helpMenu}>
      <button
        ref={trigger}
        type="button"
        className={`${styles.toolButton} ${styles.versionButton}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {version ? (
          <>
            <span className={styles.label}>v{version}</span>
            <kbd className={styles.collapsedOnly}>?</kbd>
          </>
        ) : (
          <kbd>?</kbd>
        )}
      </button>
      {open ? (
        <div
          ref={panel}
          id={`${id}-panel`}
          role="menu"
          aria-label={label}
          className={`ms-menu ${styles.helpPanel}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
              trigger.current?.focus();
            }
          }}
        >
          <div className={styles.helpAbout}>
            <strong>MepMail Correio</strong>
            {version ? (
              <span title={release.revision ? release.revision.slice(0, 12) : undefined}>
                {date ? t("versionDate", { version, date }) : t("version", { version })}
              </span>
            ) : null}
            {desktop ? (
              <span>
                {t("app", {
                  platform: PLATFORMS[desktop.platform] ?? desktop.platform,
                  version: desktop.version,
                })}{" "}
                · {t("appUpdates")}
              </span>
            ) : null}
          </div>
          <hr className="ms-menu-sep" />
          <a
            role="menuitem"
            className="ms-menu-item"
            href={version ? `/changelog#v${version}` : "/changelog"}
            target="_blank"
            rel="noopener"
            onClick={close}
          >
            <span>{t("whatsNew")}</span>
          </a>
          <button
            type="button"
            role="menuitem"
            className="ms-menu-item"
            onClick={() => {
              close();
              onShortcuts();
            }}
          >
            <span>{t("shortcuts")}</span>
            <kbd className={styles.helpKey}>?</kbd>
          </button>
          <a
            role="menuitem"
            className="ms-menu-item"
            href={DOCS_URL}
            target="_blank"
            rel="noopener"
            onClick={close}
          >
            <span>{t("docs")}</span>
          </a>
          <a
            role="menuitem"
            className="ms-menu-item"
            href={SUPPORT_CHAT}
            target="_blank"
            rel="noopener"
            onClick={close}
          >
            <span>{t("support")}</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}
