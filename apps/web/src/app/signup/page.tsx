import { env, signupOpen } from "@millionsend/config";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/components/auth/auth-form";
import { SignupClosed } from "@/components/auth/signup-closed";
import { postAuthNext } from "@/lib/nav";
import { enabledSocialProviders, hasSession } from "@/server/auth";
import { publicPageUrls } from "@/server/public-seo";
import { publicSignupAvailability } from "@/server/public-signup";
import { accountMailDelayed } from "@/server/ses-pause";
import { canarySignupRenderAllowed } from "@/server/signup-canary";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
// ALLOW_SIGNUP stays enforced server-side by the better-auth user.create hook.
// The canary door renders the same form in ONE operator browser, and only in
// the "paused" state — the operator's own admission of a closed door. "full"
// means the beta seat cap refuses everybody, canary included, so the form must
// not appear there; "open" already renders it for everyone. The cookie decides,
// so this page must never be cached or shared with a visitor who lacks it.
export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // An authenticated visitor has no business on the auth screens.
  if (await hasSession()) redirect(postAuthNext((await searchParams).next, "/"));
  const availability = await publicSignupAvailability();
  // publicSignupAvailability is unchanged: it still answers for the public
  // door, and the general CTA never learns about the canary. Only this render
  // is widened, only for the cookie holder, only in the paused state and only
  // for the password form — social sign-in stays closed even here, because the
  // public door is closed.
  const canary = availability === "paused" && (await canarySignupRenderAllowed());
  if (availability !== "open" && !canary) return <SignupClosed availability={availability} />;
  return (
    <AuthForm
      mode="signup"
      providers={
        canary ? { google: false, github: false, microsoft: false } : enabledSocialProviders()
      }
      legal={{ termsUrl: env.TERMS_URL ?? "/terms", privacyUrl: env.PRIVACY_URL ?? "/privacy" }}
      turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
      productUpdates={signupOpen()}
      mailDelayed={await accountMailDelayed()}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls("/signup");
  const t = await getTranslations("auth");
  return {
    title: t("signup.submit"),
    alternates: seo.alternates,
    robots: { index: false, follow: true },
  };
}
