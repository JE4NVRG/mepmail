import { describe, expect, it } from "vitest";
import { readMailboxSearchDocument } from "../src/mailbox-search-document.js";

describe("search document", () => {
  it("reads subject, people (Bcc too), body text and attachment names", async () => {
    const raw = Buffer.from(
      [
        "From: Ana Souza <ana@cliente.invalid>",
        "To: Jean <jean@box.invalid>, time@box.invalid",
        "Cc: financeiro@box.invalid",
        "Bcc: auditoria@box.invalid",
        "Subject: =?UTF-8?Q?Proposta_revis=C3=A3o?=",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Segue a cobrança de outubro.",
        "--b",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="nota-fiscal.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0=",
        "--b--",
        "",
      ].join("\r\n"),
    );
    expect(await readMailboxSearchDocument(raw)).toEqual({
      subject: "Proposta revisão",
      from: ["ana@cliente.invalid", "Ana Souza"],
      to: [
        "jean@box.invalid",
        "Jean",
        "time@box.invalid",
        "financeiro@box.invalid",
        "auditoria@box.invalid",
      ],
      body: "Segue a cobrança de outubro.",
      attachments: ["nota-fiscal.pdf"],
    });
  });

  it("turns HTML-only mail into text", async () => {
    const raw = Buffer.from(
      "From: a@x.invalid\r\nTo: b@y.invalid\r\nSubject: HTML\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Olá <b>mundo</b></p>\r\n",
    );
    expect((await readMailboxSearchDocument(raw)).body).toBe("Olá mundo");
  });
});
