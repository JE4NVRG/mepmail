"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { SignupCta } from "./signup-cta";
import { UserAvatar } from "./user-avatar";

export function PublicAccount({ login, signup }: { login: string; signup: string }) {
  const t = useTranslations("landing.account");
  const { data: session, isPending } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  if (isPending)
    return (
      <span className="gtm-public-account" aria-busy="true" style={{ minWidth: 130, height: 36 }} />
    );
  if (!session)
    return (
      <div className="gtm-public-account">
        <a className="gtm-nav-login" href="/login">
          {login}
        </a>
        <SignupCta className="ms-btn ms-btn-primary gtm-action" label={signup} />
      </div>
    );
  return (
    <div className="gtm-public-account">
      <a
        className="gtm-account-photo"
        href="/settings#profile"
        aria-label={t("profile")}
        title={session.user.name}
      >
        <UserAvatar size={30} />
      </a>
      <a className="ms-btn ms-btn-primary gtm-action" href="/emails">
        {t("dashboard")}
      </a>
      <button
        type="button"
        className="gtm-account-signout"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            const result = await authClient.signOut();
            if (result.error) throw new Error("signout");
            router.refresh();
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("signOut")}
      </button>
      {failed && (
        <span role="alert" className="gtm-account-error">
          {t("signOutError")}
        </span>
      )}
    </div>
  );
}
