import { describe, expect, it } from "vitest";
import {
  MAILBOX_EXTERNAL_PRESETS,
  mailboxExternalPresetFor,
} from "../../../packages/core/src/mailbox-external-providers";
import {
  MailboxExternalCheckError,
  mailboxExternalServers,
} from "../src/server/mailbox-external-connect";

describe("Contas externas: providers and servers", () => {
  it("picks the provider from the address", () => {
    expect(mailboxExternalPresetFor("Ana@Gmail.com")).toBe("gmail");
    expect(mailboxExternalPresetFor("bob@icloud.com")).toBe("icloud");
    expect(mailboxExternalPresetFor("c@yahoo.com.br")).toBe("yahoo");
    expect(mailboxExternalPresetFor("d@hotmail.com")).toBe("outlook");
    expect(mailboxExternalPresetFor("e@empresa.com.br")).toBe("imap");
  });

  it("uses the preset's servers and the address as username", () => {
    expect(mailboxExternalServers({ provider: "gmail", address: "ana@gmail.com" })).toEqual({
      provider: "gmail",
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      username: "ana@gmail.com",
    });
    expect(
      mailboxExternalServers({ provider: "icloud", address: "bob@icloud.com", username: "bob" }),
    ).toMatchObject({ smtpPort: 587, smtpSecurity: "starttls", username: "bob" });
  });

  it("ignores typed servers for a known provider (no redirect of a Gmail login)", () => {
    expect(
      mailboxExternalServers({
        provider: "gmail",
        address: "ana@gmail.com",
        imapHost: "imap.attacker.example",
        smtpHost: "smtp.attacker.example",
      }),
    ).toMatchObject({ imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com" });
  });

  it("takes the person's servers for 'Outro' and refuses names that are not public hosts", () => {
    expect(
      mailboxExternalServers({
        provider: "imap",
        address: "jean@empresa.com.br",
        imapHost: "Mail.Empresa.com.br.",
        smtpHost: "smtp.empresa.com.br",
        smtpPort: 587,
      }),
    ).toMatchObject({
      imapHost: "mail.empresa.com.br",
      smtpHost: "smtp.empresa.com.br",
      smtpPort: 587,
      smtpSecurity: "starttls",
    });
    for (const bad of ["localhost", "10.0.0.1", "", "intranet"])
      expect(() =>
        mailboxExternalServers({
          provider: "imap",
          address: "jean@empresa.com.br",
          imapHost: bad,
          smtpHost: "smtp.empresa.com.br",
        }),
      ).toThrow(MailboxExternalCheckError);
  });

  it("does not offer Outlook until Microsoft sign-in exists", () => {
    expect(MAILBOX_EXTERNAL_PRESETS.outlook.available).toBe(false);
    expect(() => mailboxExternalServers({ provider: "outlook", address: "d@hotmail.com" })).toThrow(
      MailboxExternalCheckError,
    );
  });
});
