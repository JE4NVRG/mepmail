import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxExternalOAuthFor, mailboxExternalOpen } from "@/server/routers/mailbox-external";

/**
 * Contas externas open to every team (MAILBOX_EXTERNAL_OPEN=1) while "Entrar com a Microsoft"
 * stays with the pilot teams: an Outlook.com account ships with IMAP off and its sync fails
 * until the Microsoft front resumes. Synthetic team ids and a throwaway key only.
 */
const PILOT = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function microsoftConfigured() {
  process.env.MICROSOFT_OAUTH_CLIENT_ID = "11111111-2222-4333-8444-555555555555";
  // 40 hex digits built here, so no key-like literal sits in the file.
  process.env.MICROSOFT_OAUTH_CERT_THUMBPRINT = "ab".repeat(20);
  process.env.MICROSOFT_OAUTH_CERT_PRIVATE_KEY_B64 = Buffer.from(PEM).toString("base64");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
}

describe("Contas externas: who gets which sign-in", () => {
  it("opens the accounts to every team, Microsoft only to the pilot teams", () => {
    microsoftConfigured();
    process.env.MAILBOX_EXTERNAL_TEAM_IDS = PILOT;
    process.env.MAILBOX_EXTERNAL_OPEN = "1";
    delete process.env.MAILBOX_EXTERNAL_MICROSOFT_OPEN;
    delete process.env.MAILBOX_EXTERNAL_GOOGLE_OAUTH;
    expect(mailboxExternalOpen(OTHER)).toBe(true);
    expect(mailboxExternalOAuthFor(OTHER)).toEqual({ microsoft: false, google: false });
    expect(mailboxExternalOAuthFor(PILOT)).toEqual({ microsoft: true, google: false });
  });

  it("offers Microsoft to everyone only when switched on, and Google only with its own switch", () => {
    microsoftConfigured();
    process.env.MAILBOX_EXTERNAL_OPEN = "1";
    process.env.MAILBOX_EXTERNAL_MICROSOFT_OPEN = "1";
    process.env.MAILBOX_EXTERNAL_GOOGLE_OAUTH = "1";
    expect(mailboxExternalOAuthFor(OTHER)).toEqual({ microsoft: true, google: true });
  });

  it("offers nothing where the accounts are closed, nor a provider that is not configured", () => {
    microsoftConfigured();
    process.env.MAILBOX_EXTERNAL_TEAM_IDS = PILOT;
    delete process.env.MAILBOX_EXTERNAL_OPEN;
    process.env.MAILBOX_EXTERNAL_MICROSOFT_OPEN = "1";
    expect(mailboxExternalOpen(OTHER)).toBe(false);
    expect(mailboxExternalOAuthFor(OTHER)).toEqual({ microsoft: false, google: false });
    delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    expect(mailboxExternalOAuthFor(PILOT).microsoft).toBe(false);
  });
});
