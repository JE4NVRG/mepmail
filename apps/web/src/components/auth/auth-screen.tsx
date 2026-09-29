"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import styles from "./auth.module.css";
import { SilkCanvas } from "./silk-canvas";

/** Same screen chrome as AuthForm, for the recovery and OAuth consent screens. */
export function AuthScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const tCommon = useTranslations("common");
  const tAuth = useTranslations("auth");
  return (
    <main className={styles.screen}>
      {/* Every auth screen keeps the marketing site one click away. */}
      <Link href="/" className={styles.back}>
        <span aria-hidden="true">←</span> {tAuth("backToSite")}
      </Link>
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-dark.webp" alt="" className={`ms-dark-only ${styles.backdrop}`} />
      {/* biome-ignore lint/performance/noImgElement: decorative full-bleed backdrop, no optimization needed */}
      <img src="/auth/waves-light.webp" alt="" className={`ms-light-only ${styles.backdrop}`} />
      <SilkCanvas />
      <div className={styles.column}>
        <Link href="/" className={styles.brand}>
          {/* biome-ignore lint/performance/noImgElement: static SVG logo, nothing for next/image to optimize */}
          <img
            src="/logo/mepmail-wordmark.svg"
            className="ms-wordmark"
            alt={tCommon("appName")}
            height={22}
          />
        </Link>
        <h1 className={`ms-display ${styles.headline}`}>{title}</h1>
        {children}
      </div>
    </main>
  );
}
