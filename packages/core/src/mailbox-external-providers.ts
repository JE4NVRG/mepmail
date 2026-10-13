/**
 * Contas externas (specs/correio-external-accounts.md): the servers of the providers a
 * person can connect with an app password, shared by the web (connect, test) and the
 * worker (sync, send). "imap" is any other provider, typed in by the person; "outlook"
 * waits for Microsoft OAuth (phase 2): Outlook.com refuses app passwords since 2024.
 */
export type MailboxExternalPresetId = "gmail" | "icloud" | "yahoo" | "zoho" | "outlook" | "imap";

export interface MailboxExternalPreset {
  id: MailboxExternalPresetId;
  imapHost: string | null;
  smtpHost: string | null;
  smtpPort: 465 | 587;
  smtpSecurity: "tls" | "starttls";
  /** Where the person creates the app password (null: the provider's own help). */
  appPasswordUrl: string | null;
  /** Address domains that pick this provider when the person types their address. */
  domains: readonly string[];
  /** Connectable with an app password today. */
  available: boolean;
}

export const MAILBOX_EXTERNAL_PRESETS: Record<MailboxExternalPresetId, MailboxExternalPreset> = {
  gmail: {
    id: "gmail",
    imapHost: "imap.gmail.com",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    domains: ["gmail.com", "googlemail.com"],
    available: true,
  },
  icloud: {
    id: "icloud",
    imapHost: "imap.mail.me.com",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    appPasswordUrl: "https://account.apple.com/account/manage",
    domains: ["icloud.com", "me.com", "mac.com"],
    available: true,
  },
  yahoo: {
    id: "yahoo",
    imapHost: "imap.mail.yahoo.com",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    appPasswordUrl: "https://login.yahoo.com/account/security",
    domains: ["yahoo.com", "yahoo.com.br", "ymail.com", "rocketmail.com"],
    available: true,
  },
  zoho: {
    id: "zoho",
    imapHost: "imap.zoho.com",
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    domains: ["zoho.com", "zohomail.com"],
    available: true,
  },
  outlook: {
    id: "outlook",
    imapHost: "outlook.office365.com",
    smtpHost: "smtp-mail.outlook.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    appPasswordUrl: null,
    domains: [
      "outlook.com",
      "outlook.com.br",
      "hotmail.com",
      "hotmail.com.br",
      "live.com",
      "msn.com",
    ],
    available: false,
  },
  imap: {
    id: "imap",
    imapHost: null,
    smtpHost: null,
    smtpPort: 465,
    smtpSecurity: "tls",
    appPasswordUrl: null,
    domains: [],
    available: true,
  },
};

/** The provider an address most likely belongs to ("imap" when unknown). */
export function mailboxExternalPresetFor(address: string): MailboxExternalPresetId {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  for (const preset of Object.values(MAILBOX_EXTERNAL_PRESETS))
    if (preset.domains.includes(domain)) return preset.id;
  return "imap";
}
