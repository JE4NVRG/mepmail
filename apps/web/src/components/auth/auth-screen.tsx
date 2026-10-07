"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { LandingLangSwitch } from "@/components/landing-lang-switch";
import styles from "./auth.module.css";
import { AuthArt } from "./auth-art";

/** Each access screen's own pitch beside the form; recovery and consent screens share the shell's. */
export type AuthPanel = "login" | "signup";

/**
 * Estrutura única de acesso, recuperação e consentimento. The AGPL source
 * offer lives in the site footer and the dashboard sidebar, so the form
 * itself stays free of it.
 */
export function AuthScreen({
  title,
  panel,
  children,
}: {
  title: string;
  panel?: AuthPanel | undefined;
  children: React.ReactNode;
}) {
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
          <h2>{panel ? tAuth(`${panel}.panelTitle`) : tAuth("shell.title")}</h2>
          <p className={styles.productLead}>
            {panel ? tAuth(`${panel}.panelBody`) : tAuth("shell.body")}
          </p>
          {panel === "signup" ? (
            <ul className={styles.perks}>
              {(["perkFree", "perkApis", "perkCorreio"] as const).map((key) => (
                <li key={key}>
                  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                    <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {tAuth(`signup.${key}`)}
                </li>
              ))}
            </ul>
          ) : null}
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
