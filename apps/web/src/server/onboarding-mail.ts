import { MAIL_LOCALES, type MailLocale } from "@millionsend/core";
import { accountMailCard } from "@millionsend/core/html";
import en from "../../messages/en/onboarding-email.json";
import ptBR from "../../messages/pt-BR/onboarding-email.json";

const MESSAGES = { en, "pt-BR": ptBR } as const;

export { MAIL_LOCALES, type MailLocale };

/**
 * The onboarding "Send email" body in the dashboard's locale: the first
 * email a team ever sends through the instance. Exported for tests;
 * interpolates and escapes, so strings stay in JSON.
 */
export function buildOnboardingEmail(input: {
  locale: MailLocale;
  team: string;
  dashboardUrl: string | null;
}): { subject: string; html: string; text: string } {
  const m = MESSAGES[input.locale];
  return {
    subject: m.subject,
    ...accountMailCard({
      heading: m.heading,
      paragraphs: [m.body],
      button: m.button,
      url: input.dashboardUrl ?? undefined,
      muted: [m.footer.replace("{team}", input.team)],
    }),
  };
}
