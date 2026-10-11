import { describe, expect, it } from "vitest";
import { stripMailboxPrivateHeaders } from "../src/mailbox-private-headers.js";

describe("private headers on a sent copy", () => {
  it("drops Bcc and the format marker, folded lines too, and keeps every other byte", () => {
    const raw = Buffer.from(
      "From: a@x.invalid\r\nTo: b@y.invalid\r\nBcc: hidden@z.invalid,\r\n second@z.invalid\r\nSubject: Olá\r\nX-MepMail-Format: rich\r\nMIME-Version: 1.0\r\n\r\nBcc: not a header, body text\r\n",
      "utf8",
    );
    expect(stripMailboxPrivateHeaders(raw).toString("utf8")).toBe(
      "From: a@x.invalid\r\nTo: b@y.invalid\r\nSubject: Olá\r\nMIME-Version: 1.0\r\n\r\nBcc: not a header, body text\r\n",
    );
  });

  it("returns the same buffer when there is nothing to drop, and handles bare LF and case", () => {
    const plain = Buffer.from("From: a@x.invalid\r\nTo: b@y.invalid\r\n\r\nbody");
    expect(stripMailboxPrivateHeaders(plain)).toBe(plain);
    expect(
      stripMailboxPrivateHeaders(Buffer.from("From: a\nBCC: c\nTo: b\n\nbody")).toString(),
    ).toBe("From: a\nTo: b\n\nbody");
    // A Bcc that is the last header leaves the blank line in place.
    expect(stripMailboxPrivateHeaders(Buffer.from("To: b\r\nbcc: c\r\n\r\nx")).toString()).toBe(
      "To: b\r\n\r\nx",
    );
    // No body at all.
    expect(stripMailboxPrivateHeaders(Buffer.from("To: b\r\nBcc: c\r\n")).toString()).toBe(
      "To: b\r\n",
    );
  });

  it("keeps a nested part's headers: only the top-level block is the message's", () => {
    const raw = Buffer.from(
      'To: b\r\nContent-Type: multipart/mixed; boundary="q"\r\n\r\n--q\r\nBcc: inside a part\r\n\r\nx\r\n--q--\r\n',
    );
    expect(stripMailboxPrivateHeaders(raw)).toBe(raw);
  });
});
