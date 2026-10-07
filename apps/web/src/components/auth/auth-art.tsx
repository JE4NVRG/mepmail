"use client";

import { useTranslations } from "next-intl";
import styles from "./auth.module.css";

const RECIPIENTS = ["Ana", "Sam"] as const;

/**
 * One template with a FIRST_NAME field becoming two personal messages. Drawn
 * in HTML rather than a picture, so it speaks the page's language and stays
 * sharp; the frame is shown from tablet width up, like the old artwork.
 */
export function AuthArt() {
  const t = useTranslations("auth.shell");
  const card = (name?: string) => (
    <div className={`${styles.mailCard} ${name ? styles.mailSent : styles.mailTemplate}`}>
      <span className={styles.mailFrom}>MepMail</span>
      {name ? (
        <span className={styles.mailMeta}>
          {t("art.to")} {name.toLowerCase()}@{t("art.domain")}
        </span>
      ) : null}
      <span className={styles.mailMeta}>{t("art.subject")}</span>
      <span className={styles.mailHello}>
        {t("art.hello")}{" "}
        {name ?? <span className={styles.mailChip}>FIRST_NAME</span>}
      </span>
      <span className={styles.mailLine}>{t("art.line1")}</span>
      <span className={styles.mailLine}>{t("art.line2")}</span>
      <span className={styles.mailCta}>{t("art.cta")}</span>
    </div>
  );
  return (
    <figure className={styles.art}>
      <div className={styles.artFrame} role="img" aria-label={t("artAlt")}>
        <div className={styles.artStage} aria-hidden="true">
          {card()}
          <svg className={styles.mailLinks} viewBox="0 0 60 200" preserveAspectRatio="none">
            <path d="M0 100 C 30 100, 30 52, 60 52" vectorEffect="non-scaling-stroke" />
            <path d="M0 100 C 30 100, 30 148, 60 148" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className={styles.mailOutputs}>
            {RECIPIENTS.map((name) => (
              <div key={name}>{card(name)}</div>
            ))}
          </div>
        </div>
      </div>
      <figcaption className={styles.artFooter}>{t("artCaption")}</figcaption>
    </figure>
  );
}
