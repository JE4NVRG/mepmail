"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { captchaHeaders, useTurnstile } from "@/components/turnstile";
import { authClient } from "@/lib/auth-client";
import { postAuthNext, withNext } from "@/lib/nav";
import { passwordStrength } from "@/lib/password-strength";

import styles from "./auth.module.css";
import { AuthScreen } from "./auth-screen";

import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "./social-icons";

const STRENGTH_TONES = ["", "var(--ms-danger)", "var(--ms-warn)", "var(--ms-success)"] as const;
const STRENGTH_KEYS = ["", "weak", "fair", "strong"] as const;

/** Three bars + a word under a new-password field; hidden while empty. */
export function StrengthMeter({ password }: { password: string }) {
  const t = useTranslations("auth.strength");
  const score = passwordStrength(password);
  if (score === 0) return null;
  return (
    <div className={styles.strength} style={{ color: STRENGTH_TONES[score] }} aria-live="polite">
      <div className={styles.strengthBars}>
        {[1, 2, 3].map((bar) => (
          <span key={bar} className={bar <= score ? styles.strengthBarOn : styles.strengthBar} />
        ))}
      </div>
      <span className={styles.strengthLabel}>{t(STRENGTH_KEYS[score])}</span>
    </div>
  );
}

/** Show/hide glyph for the password fields: open eye, or struck when revealed. */
function EyeGlyph({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
      {off ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}

export type SocialProviderFlags = { google: boolean; github: boolean; microsoft: boolean };
export type LegalLinks = { termsUrl: string | null; privacyUrl: string | null };
type SocialProvider = keyof SocialProviderFlags;

/**
 * The full login/signup screen. Server pages pass the env-derived provider
 * flags; everything else (fields, redirects, errors) lives client-side on
 * better-auth's client, as before the redesign.
 */
export function AuthForm({
  mode,
  providers,
  legal,
  forgotPassword = false,
  turnstileSiteKey = null,
  productUpdates = false,
}: {
  mode: "login" | "signup";
  providers: SocialProviderFlags;
  legal: LegalLinks;
  /** Login only: render the "Forgot password?" link (instance can send the reset email). */
  forgotPassword?: boolean;
  /** Set when the instance verifies a Turnstile token on the email form. */
  turnstileSiteKey?: string | null;
  /** Cadastro: oferece o double opt-in separado de novidades. */
  productUpdates?: boolean;
}) {
  const t = useTranslations(`auth.${mode}`);
  const tSocial = useTranslations("auth.social");
  const tLegal = useTranslations("auth.legal");

  const tAuth = useTranslations("auth");
  const params = useSearchParams();
  // An invited user carries ?next=/invite/... — signup sends them to accept
  // the invite rather than /onboarding (which would create a new team).
  const nextParam = params.getAll("next").length === 1 ? params.get("next") : null;
  const next = postAuthNext(nextParam, mode === "login" ? "/emails" : "/onboarding", true);
  const recoveryHref = withNext("/forgot-password", nextParam);
  // better-auth bounces failed OAuth callbacks to errorCallbackURL?error=code.
  const socialError = params.get("error");
  const socialFailed = socialError !== null;

  const [name, setName] = useState("");
  // An invite link carries the invited address; signup starts from it.
  const [email, setEmail] = useState(mode === "signup" ? (params.get("email") ?? "") : "");
  const [password, setPassword] = useState("");
  const [updatesOptIn, setUpdatesOptIn] = useState(false);
  const [updatesFailed, setUpdatesFailed] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    socialFailed ? tSocial(socialError === "account_not_linked" ? "notLinked" : "error") : null,
  );
  const [pending, setPending] = useState<"email" | SocialProvider | null>(null);
  // An instance that verifies addresses creates the account without a
  // session; the form gives way to a notice until the emailed link is opened.
  const [awaitingVerification, setAwaitingVerification] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  // Where the emailed verification link lands: a page that sends the
  // verified visitor on to sign in for `next`, or explains an expired link.
  const verifyCallback = `/verify-email?next=${encodeURIComponent(next)}`;
  // Login is email-first: the password field appears on the first "Sign in",
  // so the common flow starts as a single field. Signup shows everything.
  const [passwordShown, setPasswordShown] = useState(mode === "signup");
  const passwordRef = useRef<HTMLInputElement>(null);
  const turnstile = useTurnstile(turnstileSiteKey);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending !== null) return;
    if (!passwordShown) {
      setPasswordShown(true);
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }

    setPending("email");
    setErrorMessage(null);
    let token: string | null;
    try {
      token = await turnstile.getToken();
    } catch {
      setErrorMessage(t("captcha"));
      setPending(null);
      return;
    }
    const fetchOptions = { headers: captchaHeaders(token) };
    try {
      // O callback explícito também preserva a oferta no reenvio por login não verificado.
      const { data, error } =
        mode === "login"
          ? await authClient.signIn.email({
              email,
              password,
              ...(nextParam ? { callbackURL: next } : {}),
              fetchOptions,
            })
          : await authClient.signUp.email({
              name,
              email,
              password,
              callbackURL: verifyCallback,
              fetchOptions,
            });
      if (error) {
        // The server re-sent the verification link with this attempt.
        if (error.code === "EMAIL_NOT_VERIFIED") {
          setNotice(t("unverified", { email }));
          setPending(null);
          return;
        }
        // Signup shows server messages (e.g. the signup-disabled policy)
        // verbatim; login never echoes the server, only the catalog copy.
        setErrorMessage(
          error.code === "VERIFICATION_FAILED" || error.code === "MISSING_RESPONSE"
            ? t("captcha")
            : (mode === "signup" && error.message) || t("error"),
        );
        setPending(null);
        return;
      }
      // A escolha apenas solicita confirmação; não cadastra contato de marketing.
      if (mode === "signup" && productUpdates && updatesOptIn) {
        try {
          const response = await fetch("/api/updates/subscribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, source: "updates" }),
            signal: AbortSignal.timeout(5000),
          });
          setUpdatesFailed(!response.ok);
        } catch {
          setUpdatesFailed(true);
        }
      }
      // A sign-in that resumes a pending OAuth authorization answers with the
      // consent URL; the auth client has already navigated there.
      const resumed = data as { redirect?: boolean; url?: string; token?: string | null } | null;
      if (resumed?.redirect && resumed.url) return;
      // No session token: the address must be verified first.
      if (mode === "signup" && !resumed?.token) {
        setAwaitingVerification(email);
        setPending(null);
        return;
      }
      // The dashboard layout guard bounces team-less users to /onboarding.
      // Start a fresh document/cache at the authentication boundary.
      window.location.assign(next);
    } catch {
      setErrorMessage(tAuth("networkError"));
      setPending(null);
    }
  }

  async function resendVerification() {
    if (!awaitingVerification || pending !== null) return;
    setPending("email");
    setResent(false);
    setNotice(null);
    let token: string | null;
    try {
      token = await turnstile.getToken();
    } catch {
      setNotice(t("captcha"));
      setPending(null);
      return;
    }
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: awaitingVerification,
        callbackURL: verifyCallback,
        fetchOptions: { headers: captchaHeaders(token) },
      });
      if (error) {
        setNotice(
          error.code === "VERIFICATION_FAILED" || error.code === "MISSING_RESPONSE"
            ? t("captcha")
            : t("resendFailed"),
        );
      } else {
        setResent(true);
      }
    } catch {
      setNotice(tAuth("networkError"));
    } finally {
      setPending(null);
    }
  }

  async function onSocial(provider: SocialProvider) {
    if (pending !== null) return;
    setPending(provider);
    setErrorMessage(null);
    try {
      const { error } = await authClient.signIn.social({
        provider,
        callbackURL: next,
        errorCallbackURL: withNext(mode === "login" ? "/login" : "/signup", nextParam),
      });
      if (error) {
        setErrorMessage(tSocial("error"));
        setPending(null);
      }
    } catch {
      setErrorMessage(tAuth("networkError"));
      setPending(null);
    }
  }

  const otherPage =
    mode === "login"
      ? `/signup?next=${encodeURIComponent(next)}`
      : nextParam
        ? `/login?next=${encodeURIComponent(next)}`
        : "/login";
  const anySocial = providers.google || providers.github || providers.microsoft;

  if (awaitingVerification) {
    return (
      <AuthScreen title={t("verifyTitle")}>
        <p className={styles.notice} aria-live="polite">
          {t("verifySent", { email: awaitingVerification })}
        </p>
        {updatesOptIn ? (
          <p className={styles.notice} role="status">
            {tLegal(updatesFailed ? "updatesFailed" : "updatesRequested")}{" "}
            <Link href="/updates">{tLegal("updatesManage")}</Link>
          </p>
        ) : null}
        <button
          type="button"
          className={`ms-btn ms-btn-secondary ${styles.button}`}
          disabled={pending !== null}
          onClick={resendVerification}
        >
          {pending ? tAuth("pending.email") : t("resend")}
        </button>
        {resent ? (
          <p className={styles.notice} role="status">
            {t("resent")}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.error} role="alert">
            {notice}
          </p>
        ) : null}
        {turnstile.slot}
        <p className={styles.subline}>
          <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("backToLogin")}</Link>
        </p>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen title={t("title")}>
      <p className={styles.subline}>
        {t("subline")} <Link href={otherPage}>{t("sublineLink")}</Link>
      </p>
      {anySocial ? (
        <div className={styles.social}>
          {providers.google ? (
            <button
              type="button"
              className={`ms-btn ms-btn-secondary ${styles.button}`}
              disabled={pending !== null}
              onClick={() => onSocial("google")}
            >
              <GoogleIcon />
              {tSocial("google")}
            </button>
          ) : null}
          {providers.github ? (
            <button
              type="button"
              className={`ms-btn ms-btn-secondary ${styles.button}`}
              disabled={pending !== null}
              onClick={() => onSocial("github")}
            >
              <GitHubIcon />
              {tSocial("github")}
            </button>
          ) : null}
          {providers.microsoft ? (
            <button
              type="button"
              className={`ms-btn ms-btn-secondary ${styles.button}`}
              disabled={pending !== null}
              onClick={() => onSocial("microsoft")}
            >
              <MicrosoftIcon />
              {tSocial("microsoft")}
            </button>
          ) : null}
        </div>
      ) : null}
      {anySocial ? <div className={styles.divider}>{tSocial("or")}</div> : null}
      <p className={styles.hint} id="auth-step" aria-live="polite">
        {tAuth(
          mode === "signup"
            ? "shell.signupHint"
            : passwordShown
              ? "shell.passwordHint"
              : "shell.emailHint",
        )}
      </p>
      <p className={styles.pending} role="status" aria-live="polite">
        {pending ? tAuth(`pending.${pending}`) : null}
      </p>
      <form
        onSubmit={onSubmit}
        className={styles.form}
        aria-busy={pending !== null}
        aria-describedby={errorMessage ? "auth-error auth-step" : "auth-step"}
      >
        {mode === "signup" ? (
          <div className={`ms-field ${styles.field}`}>
            <label htmlFor="name">{t("name")}</label>
            <input
              id="name"
              type="text"
              className={`ms-input ${styles.control}`}
              autoComplete="name"
              placeholder={t("namePlaceholder")}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        ) : null}
        <div className={`ms-field ${styles.field}`}>
          <label htmlFor="email">{t("email")}</label>
          <input
            id="email"
            type="email"
            aria-describedby={errorMessage ? "auth-error" : undefined}
            className={`ms-input ${styles.control}`}
            autoComplete="email"
            placeholder={t("emailPlaceholder")}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {passwordShown ? (
          <div className={`ms-field ${styles.field} ${styles.passwordStep}`}>
            <div className={styles.labelRow}>
              <label htmlFor="password">{t("password")}</label>
              {mode === "login" && forgotPassword ? (
                <Link
                  href={
                    email.trim()
                      ? `${recoveryHref}${recoveryHref.includes("?") ? "&" : "?"}email=${encodeURIComponent(email.trim())}`
                      : recoveryHref
                  }
                  className={styles.forgot}
                >
                  {t("forgot")}
                </Link>
              ) : null}
            </div>
            <div className={styles.passwordWrap}>
              <input
                ref={passwordRef}
                id="password"
                aria-describedby={errorMessage ? "auth-error" : undefined}
                type={revealPassword ? "text" : "password"}
                className={`ms-input ${styles.control}`}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={t("passwordPlaceholder")}
                required
                minLength={mode === "signup" ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={styles.eye}
                aria-pressed={revealPassword}
                aria-label={revealPassword ? t("hidePassword") : t("showPassword")}
                onClick={() => setRevealPassword((v) => !v)}
              >
                <EyeGlyph off={revealPassword} />
              </button>
            </div>
            {mode === "signup" ? <StrengthMeter password={password} /> : null}
          </div>
        ) : null}
        {mode === "signup" && productUpdates ? (
          <label className={styles.updatesChoice} htmlFor="product-updates">
            <input
              id="product-updates"
              type="checkbox"
              checked={updatesOptIn}
              onChange={(event) => setUpdatesOptIn(event.target.checked)}
            />
            <span>{tLegal("updates")}</span>
          </label>
        ) : null}
        {errorMessage ? (
          <p className={styles.error} id="auth-error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.notice} aria-live="polite">
            {notice}
          </p>
        ) : null}
        {turnstile.slot}
        <button
          type="submit"
          className={`ms-btn ms-btn-primary ${styles.button}`}
          disabled={pending !== null}
        >
          {pending
            ? tAuth(`pending.${pending}`)
            : !passwordShown
              ? tAuth("continueEmail")
              : t("submit")}
        </button>
      </form>
      {legal.termsUrl || legal.privacyUrl ? (
        <p className={styles.legal}>
          {legal.termsUrl || legal.privacyUrl
            ? tLegal.rich(
                // The sentence names only the documents that exist.
                `${mode}.${legal.termsUrl && legal.privacyUrl ? "both" : legal.termsUrl ? "terms" : "privacy"}`,
                {
                  terms: (chunks) => (
                    <a href={legal.termsUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                      {chunks}
                    </a>
                  ),
                  privacy: (chunks) => (
                    <a href={legal.privacyUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                      {chunks}
                    </a>
                  ),
                },
              )
            : null}
        </p>
      ) : null}
    </AuthScreen>
  );
}
