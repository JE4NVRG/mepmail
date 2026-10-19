import { describe, expect, it } from "vitest";
import { imapRefusalDetail } from "../src/mailbox-imap-client.js";

/** A refused IMAP sign-in keeps the server's words for the logs, never a credential. */
describe("imapRefusalDetail", () => {
  it("keeps the tagged NO text and the decoded XOAUTH2 error", () => {
    const sasl = Buffer.from('{"status":"401","schemes":"bearer"}').toString("base64");
    expect(imapRefusalDetail("NO AUTHENTICATE failed.", sasl)).toBe(
      'NO AUTHENTICATE failed. sasl={"status":"401","schemes":"bearer"}',
    );
  });

  it("drops a continuation that is not printable text and trims long answers", () => {
    const binary = Buffer.from([0, 1, 2, 250]).toString("base64");
    expect(imapRefusalDetail("NO [AUTHENTICATIONFAILED] Invalid\r\n", binary)).toBe(
      "NO [AUTHENTICATIONFAILED] Invalid",
    );
    expect(imapRefusalDetail(`NO ${"x".repeat(400)}`, null)).toHaveLength(300);
  });
});
