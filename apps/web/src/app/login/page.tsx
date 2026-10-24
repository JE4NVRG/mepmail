import { env } from "@millionsend/config";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthForm } from "@/components/auth/auth-form";
import { POST_LOGIN_PATH, postAuthNext } from "@/lib/nav";
import { enabledSocialProviders, hasSession } from "@/server/auth";
import { publicPageUrls } from "@/server/public-seo";
import { accountMailDelayed } from "@/server/ses-pause";
import { signupBotProtectionEnabled } from "@/server/signup-bot-protection";
import { passwordRecoveryEnabled } from "@/server/system-mail";

// Server component so the env-derived social-provider flags reach the client
// form as props; the form itself keeps the better-auth client mechanism.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  // An authenticated visitor has no business on the auth screens.
  if (await hasSession()) redirect(postAuthNext((await searchParams).next, POST_LOGIN_PATH, true));
  return (
    <AuthForm
      mode="login"
      providers={enabledSocialProviders()}
      legal={{ termsUrl: env.TERMS_URL ?? "/terms", privacyUrl: env.PRIVACY_URL ?? "/privacy" }}
      forgotPassword={passwordRecoveryEnabled()}
      turnstileSiteKey={env.TURNSTILE_SITE_KEY ?? null}
      requireLoginCaptcha={!signupBotProtectionEnabled()}
      mailDelayed={await accountMailDelayed()}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls("/login");
  const t = await getTranslations("auth");
  return {
    title: t("login.submit"),
    alternates: seo.alternates,
    robots: { index: false, follow: true },
  };
}
