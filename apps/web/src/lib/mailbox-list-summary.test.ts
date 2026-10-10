import { describe, expect, it } from "vitest";
import {
  decodeMailboxListSummary,
  encodeMailboxListSummary,
  MAILBOX_LIST_SUMMARY_BYTES,
} from "./mailbox-list-summary";

const base = {
  subject: "Re: Configurando o domínio",
  from: "maya@example.com",
  fromName: "Maya Chen",
  to: ["ana@sualoja.com.br"],
  text: "Oi, Ana!   Adicionei os registros DKIM https://example.com/x na Cloudflare.",
  date: new Date("2026-10-10T11:42:00Z"),
  attachmentCount: 2,
};

describe("mailbox list summary", () => {
  it("round-trips what a list row shows, with the text already a preview", () => {
    const encoded = encodeMailboxListSummary(base);
    expect(encoded).not.toBeNull();
    expect(decodeMailboxListSummary(encoded as Buffer)).toEqual({
      ...base,
      text: "Oi, Ana! Adicionei os registros DKIM na Cloudflare.",
    });
  });

  it("stays small for long messages and many recipients", () => {
    const encoded = encodeMailboxListSummary({
      ...base,
      subject: "s".repeat(5000),
      text: "palavra ".repeat(10000),
      to: Array.from({ length: 200 }, (_, i) => `pessoa${i}@example.com`),
    });
    expect(encoded).not.toBeNull();
    expect((encoded as Buffer).length).toBeLessThan(MAILBOX_LIST_SUMMARY_BYTES);
    const decoded = decodeMailboxListSummary(encoded as Buffer);
    expect(decoded?.to).toHaveLength(10);
    expect(decoded?.subject).toHaveLength(500);
  });

  it("keeps a missing date and refuses anything that is not its own shape", () => {
    const encoded = encodeMailboxListSummary({ ...base, date: null });
    expect(decodeMailboxListSummary(encoded as Buffer)?.date).toBeNull();
    expect(decodeMailboxListSummary(Buffer.from("not json"))).toBeNull();
    expect(decodeMailboxListSummary(Buffer.from(JSON.stringify({ v: 2, s: "x" })))).toBeNull();
    expect(decodeMailboxListSummary(Buffer.from(JSON.stringify({ v: 1, s: 1 })))).toBeNull();
  });
});
