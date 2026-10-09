import { describe, expect, it } from "vitest";
import {
  mailboxIdKey,
  mailboxProviderThreadKeys,
  mailboxThreadKeys,
} from "../src/mailbox-thread.js";

const mime = (headers: string, body = "Olá") =>
  new TextEncoder().encode(`${headers.replace(/\n/g, "\r\n")}\r\n\r\n${body}`);

describe("Correio conversation keys", () => {
  it("roots a first message at itself", () => {
    const keys = mailboxThreadKeys(
      mime("From: a@example.com\nMessage-ID: <first@example.com>\nSubject: Oi"),
    );
    expect(keys.messageKey).toBe(mailboxIdKey("<first@example.com>"));
    expect(keys.threadKey).toBe(keys.messageKey);
  });

  it("roots a reply at the oldest reference, folded or not", () => {
    const reply = mailboxThreadKeys(
      mime(
        "Message-ID: <third@mepmail.dev>\nIn-Reply-To: <second@example.com>\nReferences: <first@example.com>\n <second@example.com>",
      ),
    );
    expect(reply.threadKey).toBe(mailboxIdKey("<first@example.com>"));
    expect(reply.messageKey).toBe(mailboxIdKey("<third@mepmail.dev>"));
    const parentOnly = mailboxThreadKeys(
      mime("Message-ID: <b@x.example>\nIn-Reply-To: <a@x.example>"),
    );
    expect(parentOnly.threadKey).toBe(mailboxIdKey("<a@x.example>"));
  });

  it("matches IDs case-insensitively and ignores the body and junk", () => {
    const upper = mailboxThreadKeys(mime("Message-ID: <First@Example.COM>"));
    expect(upper.messageKey).toBe(mailboxIdKey("<first@example.com>"));
    const none = mailboxThreadKeys(
      mime("Subject: no ids\nReferences: not-an-id", "Message-ID: <body@example.com>"),
    );
    expect(none).toEqual({ messageKey: null, threadKey: null });
  });

  it("moves a self-rooted sent message to the provider ID, not a reply", () => {
    const own = mailboxThreadKeys(mime("Message-ID: <draft@mepmail.dev>"));
    const moved = mailboxProviderThreadKeys(own, "<0100abc@email.amazonses.com>");
    expect(moved.messageKey).toBe(mailboxIdKey("<0100abc@email.amazonses.com>"));
    expect(moved.threadKey).toBe(moved.messageKey);
    const reply = mailboxThreadKeys(
      mime("Message-ID: <r@mepmail.dev>\nReferences: <root@example.com>"),
    );
    expect(mailboxProviderThreadKeys(reply, "<0100def@email.amazonses.com>").threadKey).toBe(
      mailboxIdKey("<root@example.com>"),
    );
  });
});
