"use client";

import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { useDismiss } from "@/components/popover-menu";
import type { CorreioPrefs } from "@/lib/mailbox-preferences";
import { MailboxFolderIcon } from "./mailbox-folder-icon";
import styles from "./mailboxes.module.css";

type Choice<K extends keyof CorreioPrefs> = { value: CorreioPrefs[K]; label: string };

/**
 * "Exibição": the list's own look, changed in place. Density, preview lines,
 * reading pane and initials, each a radio group with a check on the current
 * value; every choice is written to the person's preferences at once.
 */
export function MailboxViewMenu({
  prefs,
  setPref,
}: {
  prefs: CorreioPrefs;
  setPref: (patch: Partial<CorreioPrefs>) => void;
}) {
  const t = useTranslations("mailboxes.view");
  const id = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss([panel, trigger], open, () => setOpen(false));

  const density: Choice<"density">[] = [
    { value: "comfortable", label: t("comfortable") },
    { value: "compact", label: t("compact") },
  ];
  const preview: Choice<"previewLines">[] = [
    { value: 0, label: t("previewNone") },
    { value: 1, label: t("previewOne") },
    { value: 2, label: t("previewTwo") },
  ];
  const pane: Choice<"readingPane">[] = [
    { value: "right", label: t("paneRight") },
    { value: "bottom", label: t("paneBottom") },
    { value: "off", label: t("paneOff") },
  ];

  function group<K extends keyof CorreioPrefs>(key: K, label: string, choices: Choice<K>[]) {
    return (
      <fieldset className={styles.viewMenuGroup}>
        <legend className="ms-menu-label">{label}</legend>
        {choices.map((choice) => {
          const checked = prefs[key] === choice.value;
          return (
            <button
              key={String(choice.value)}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              className="ms-menu-item"
              onClick={() => setPref({ [key]: choice.value } as Partial<CorreioPrefs>)}
            >
              <span>{choice.label}</span>
              {checked ? (
                <span aria-hidden="true" className={styles.viewMenuCheck}>
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </fieldset>
    );
  }

  return (
    <div className={styles.viewMenu}>
      <button
        ref={trigger}
        type="button"
        className="ms-btn ms-btn-ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        title={t("title")}
        onClick={() => setOpen((value) => !value)}
      >
        <MailboxFolderIcon name="sliders" />
        <span className={styles.narrowHidden}>{t("title")}</span>
      </button>
      {open ? (
        <div
          ref={panel}
          id={`${id}-panel`}
          role="menu"
          aria-label={t("title")}
          className={`ms-menu ${styles.viewMenuPanel}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {group("density", t("density"), density)}
          <hr className="ms-menu-sep" />
          {group("previewLines", t("previewLines"), preview)}
          <hr className="ms-menu-sep" />
          {group("readingPane", t("readingPane"), pane)}
          <hr className="ms-menu-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={prefs.showAvatars}
            className="ms-menu-item"
            onClick={() => setPref({ showAvatars: !prefs.showAvatars })}
          >
            <span>{t("showAvatars")}</span>
            {prefs.showAvatars ? (
              <span aria-hidden="true" className={styles.viewMenuCheck}>
                ✓
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}
