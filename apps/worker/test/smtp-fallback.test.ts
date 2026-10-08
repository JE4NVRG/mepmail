import { expect, it } from "vitest";
import {
  createCustomerSmtpRelay,
  createSmtpFallback,
  type SmtpTransport,
} from "../src/handlers/smtp-fallback.js";

function fakeTransport(messageId?: string) {
  const mails: Parameters<SmtpTransport["sendMail"]>[0][] = [];
  const transport: SmtpTransport = {
    async sendMail(mail) {
      mails.push(mail);
      return messageId === undefined ? {} : { messageId };
    },
  };
  return { transport, mails };
}

const raw = Buffer.from("From: Acme <billing@acme.dev>\r\nSubject: hi\r\n\r\nhi\r\n");

it("the customer relay sends the raw MIME from the message's own From, to every recipient", async () => {
  const { transport, mails } = fakeTransport("<abc@relay.example>");
  const relay = createCustomerSmtpRelay(
    "smtps://res.app.tenant:pw@smtp.example:465",
    "azure",
    transport,
  );
  const sent = await relay.sendRaw({
    raw,
    emailId: "e-1",
    to: ["r@example.com"],
    cc: ["c@example.com"],
    bcc: ["b@example.com"],
    configurationSetName: "ignored",
    region: "us-east-1",
    envelopeFrom: "billing@acme.dev",
  });
  expect(sent.messageId).toBe("smtp-relay:azure:<abc@relay.example>");
  expect(mails).toEqual([
    {
      envelope: {
        from: "billing@acme.dev",
        to: ["r@example.com", "c@example.com", "b@example.com"],
      },
      raw,
    },
  ]);

  // No id from the relay: the row's own id keeps the prefix.
  const bare = createCustomerSmtpRelay(
    "smtp://relay.example:587",
    "oci",
    fakeTransport().transport,
  );
  expect(
    (await bare.sendRaw({ raw, emailId: "e-2", to: ["r@example.com"], envelopeFrom: "a@acme.dev" }))
      .messageId,
  ).toBe("smtp-relay:oci:e-2");
});

it("the customer relay refuses a send without an envelope sender, its login being no mailbox", async () => {
  const { transport, mails } = fakeTransport("<x@relay>");
  const relay = createCustomerSmtpRelay(
    "smtps://res.app.tenant:pw@smtp.example:465",
    "azure",
    transport,
  );
  await expect(relay.sendRaw({ raw, emailId: "e-3", to: ["r@example.com"] })).rejects.toThrow(
    "envelope sender",
  );
  expect(mails).toHaveLength(0);
});

it("the platform fallback keeps its authenticated mailbox as the envelope sender", async () => {
  const { transport, mails } = fakeTransport("<f@purely>");
  const fallback = createSmtpFallback(
    "smtps://noreply%40platform.dev:pw@smtp.example:465",
    transport,
  );
  const sent = await fallback.sendRaw({
    raw,
    emailId: "e-4",
    to: ["r@example.com"],
    envelopeFrom: "billing@acme.dev",
  });
  expect(sent.messageId).toBe("smtp-fallback:<f@purely>");
  expect(mails[0]?.envelope.from).toBe("noreply@platform.dev");
  expect(() => createSmtpFallback("smtps://user:pw@smtp.example:465")).toThrow(
    "SMTP_FALLBACK_URL user must be a mailbox address",
  );
});
