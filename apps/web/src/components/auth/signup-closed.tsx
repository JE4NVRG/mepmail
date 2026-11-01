import { getLocale } from "next-intl/server";
import { LandingLangSwitch } from "@/components/landing-lang-switch";
import { publicSignupCopy } from "@/lib/public-signup-copy";
import type { PublicSignupAvailability } from "@/server/public-signup";
import styles from "./auth.module.css";

/** Deliberately not AuthScreen: its signup panel promises immediate access. */
export async function SignupClosed({
  availability,
}: {
  availability: Exclude<PublicSignupAvailability, "open">;
}) {
  const locale = await getLocale();
  const copy = publicSignupCopy(locale);
  return (
    <main className={styles.screen}>
      <header className={styles.topbar}>
        <a href="/" className={styles.back}>
          {copy.back}
        </a>
        <LandingLangSwitch label={locale === "pt-BR" ? "Idioma" : "Language"} />
      </header>
      <div className={styles.layout}>
        <aside className={styles.product} aria-label="MepMail">
          <p className={styles.eyebrow}>MepMail / API · SMTP · MCP</p>
          <h2>{copy[availability]}</h2>
        </aside>
        <div className={styles.column}>
          <a href="/" className={styles.brand}>
            MepMail
          </a>
          <h1 className={`ms-display ${styles.headline}`}>{copy[availability]}</h1>
          <p className={styles.notice}>
            {availability === "full" ? copy.fullBody : copy.pausedBody}
          </p>
          <nav className={styles.form} aria-label={copy.links}>
            <a
              className={`ms-btn ms-btn-primary ${styles.button} ${styles.closedLogin}`}
              href="/login"
            >
              {copy.login}
            </a>
            <a className={styles.back} href="/status">
              {copy.status}
            </a>
            <a className={styles.back} href="/source">
              {copy.source}
            </a>
            <a className={styles.back} href="/support">
              {copy.contact}
            </a>
          </nav>
        </div>
      </div>
    </main>
  );
}
