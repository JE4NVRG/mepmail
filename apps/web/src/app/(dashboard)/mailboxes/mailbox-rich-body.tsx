"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import styles from "./mailboxes.module.css";

export function MailboxRichBody({
  text,
  html,
  externalHtml,
  externalImages,
}: {
  text: string;
  html: string | null;
  externalHtml: string | null;
  externalImages: number;
}) {
  const t = useTranslations("mailboxes");
  const [formatted, setFormatted] = useState(!!html);
  const [showImages, setShowImages] = useState(false);
  const body = showImages && externalHtml ? externalHtml : html;
  // The HTML is sanitized on the server. This frame also isolates styles and navigation.
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:${showImages ? " https:" : ""}; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{margin:0;padding:20px;color:#202124;background:#fff;font:14px/1.6 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#6741c5}</style></head><body>${body ?? ""}</body></html>`;
  return (
    <section className={styles.richBody} aria-label={t("message")}>
      {html ? (
        <div className={styles.bodyControls}>
          <fieldset aria-label={t("bodyFormat")}>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-pressed={formatted}
              onClick={() => setFormatted(true)}
            >
              {t("formattedBody")}
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-pressed={!formatted}
              onClick={() => setFormatted(false)}
            >
              {t("plainBody")}
            </button>
          </fieldset>
          {formatted && externalImages > 0 && !showImages ? (
            <div className={styles.externalImages}>
              <p>{t("externalImagesHelp", { count: externalImages })}</p>
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                onClick={() => setShowImages(true)}
              >
                {t("showExternalImages")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {formatted && body ? (
        <iframe
          title={t("formattedBody")}
          className={styles.htmlMessage}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={document}
        />
      ) : (
        <div className={styles.messageBody}>{text || t("noText")}</div>
      )}
    </section>
  );
}
