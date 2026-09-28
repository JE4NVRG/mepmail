import { env } from "@millionsend/config";

export interface LegalLinks {
  terms: string;
  privacy: string;
  refund: string;
}

/** Legal destinations of the public chrome; self-hosted instances may point elsewhere. */
export function legalLinks(): LegalLinks {
  return {
    terms: env.TERMS_URL ?? "/terms",
    privacy: env.PRIVACY_URL ?? "/privacy",
    refund: "/refund",
  };
}
