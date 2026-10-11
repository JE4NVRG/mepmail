import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailbox-mailto";

describe("parseMailto", () => {
  it("reads recipients, copies, subject and body", () => {
    expect(
      parseMailto(
        "mailto:maya@brightloop.example,priya@atlaslabs.example?cc=ana@example.com&bcc=ops@example.com&subject=Proposta%20de%20piloto&body=Oi%20Maya%2C%0D%0A%0D%0ASegue%20a%20proposta.",
      ),
    ).toEqual({
      to: ["maya@brightloop.example", "priya@atlaslabs.example"],
      cc: ["ana@example.com"],
      bcc: ["ops@example.com"],
      subject: "Proposta de piloto",
      body: "Oi Maya,\n\nSegue a proposta.",
    });
  });

  it("keeps a plus sign, merges to= with the path and drops duplicates and junk", () => {
    expect(
      parseMailto(
        "MAILTO:jean+news@mepmail.dev?to=JEAN+news@mepmail.dev,not-an-address&subject=1+1",
      ),
    ).toEqual({ to: ["jean+news@mepmail.dev"], cc: [], bcc: [], subject: "1+1", body: "" });
  });

  it("keeps the subject on one line", () => {
    expect(parseMailto("mailto:a@b.co?subject=Linha%0D%0ABcc%3A%20x@y.z")?.subject).toBe(
      "Linha Bcc: x@y.z",
    );
  });

  it("refuses what is not a mailto link or is too long", () => {
    expect(parseMailto("https://mepmail.dev")).toBeNull();
    expect(parseMailto(`mailto:a@b.co?body=${"x".repeat(17_000)}`)).toBeNull();
    expect(parseMailto("mailto:")).toEqual({ to: [], cc: [], bcc: [], subject: "", body: "" });
  });
});
