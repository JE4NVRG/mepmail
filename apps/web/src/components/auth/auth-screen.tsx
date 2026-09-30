"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LandingLangSwitch } from "@/components/landing-lang-switch";
import styles from "./auth.module.css";
import { AuthArt } from "./auth-art";

/** Estrutura única de acesso, recuperação e consentimento. */
export function AuthScreen({ title, children }: { title: string; children: React.ReactNode }) {
  const tCommon = useTranslations("common");
  const tAuth = useTranslations("auth");
  const tLanding = useTranslations("landing");
  return (
    <main className={styles.screen}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.back}>
          <span aria-hidden="true">←</span> {tAuth("backToSite")}
        </Link>
        <LandingLangSwitch label={tLanding("lang.aria")} />
      </header>
      <div className={styles.layout}>
        <aside className={styles.product} aria-label={tAuth("shell.productLabel")}>
          <p className={styles.eyebrow}>MepMail / API · SMTP · MCP</p>
          <h2>{tAuth("shell.title")}</h2>
          <p className={styles.productLead}>{tAuth("shell.body")}</p>
          <AuthArt />
        </aside>
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
      </div>
    </main>
  );
}
