"use client";

import { useTranslations } from "next-intl";
import styles from "./auth.module.css";

const IMAGE = "/product/auth-personalization.webp";
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export function AuthArt() {
  const t = useTranslations("auth.shell");

  return (
    <figure className={styles.art}>
      <div className={styles.artFrame}>
        <picture>
          <source media="(min-width: 960px)" srcSet={IMAGE} type="image/webp" />
          {/* picture nativo evita download da arte no mobile e funciona sem JS. */}
          <img src={EMPTY_IMAGE} width={960} height={960} alt={t("artAlt")} />
        </picture>
      </div>
      <figcaption className={styles.artFooter}>{t("artCaption")}</figcaption>
    </figure>
  );
}
