import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isRecipientAddress,
  mailboxContacts,
  matchContacts,
  mergeRecipients,
  recipientAddress,
  splitRecipients,
} from "../src/lib/mailbox-recipients";

describe("composer recipients", () => {
  it("accepts exactly what the server's z.email() accepts", () => {
    const samples = [
      "ana@example.com",
      "ana.costa+loja@sub.example.com.br",
      "o'neil@example.ie",
      "a_b-c@ex-ample.co",
      "ana@example",
      "ana@@example.com",
      "ana@.example.com",
      ".ana@example.com",
      "ana..costa@example.com",
      "ana costa@example.com",
      "ana@exam_ple.com",
      "ana@example.c",
      "Ana <ana@example.com>",
      "",
      `${"a".repeat(250)}@x.com`,
    ];
    const server = z.email().max(254);
    for (const sample of samples)
      expect([sample, isRecipientAddress(sample)]).toEqual([
        sample,
        server.safeParse(sample).success,
      ]);
  });

  it("takes the address out of names, mailto and quotes", () => {
    expect(recipientAddress("  Ana Costa <ana@example.com> ")).toBe("ana@example.com");
    expect(recipientAddress("mailto:ana@example.com")).toBe("ana@example.com");
    expect(recipientAddress('"ana@example.com"')).toBe("ana@example.com");
  });

  it("splits typed and pasted lists at commas, semicolons, lines and spaces", () => {
    expect(splitRecipients("a@x.com, b@y.com;c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(splitRecipients("a@x.com b@y.com\nc@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(splitRecipients("Ana Costa <ana@x.com>, Bia <bia@y.com>")).toEqual([
      "ana@x.com",
      "bia@y.com",
    ]);
    // A typo stays, so the composer can show it in red.
    expect(splitRecipients("ana@x, , ")).toEqual(["ana@x"]);
  });

  it("adds each address once, whatever its case", () => {
    expect(mergeRecipients(["Ana@X.com"], ["ana@x.com", "bia@y.com", "BIA@y.com"])).toEqual([
      "Ana@X.com",
      "bia@y.com",
    ]);
  });

  it("builds suggestions from recent, sent and inbox, without no-reply or the mailbox itself", () => {
    const contacts = mailboxContacts(
      [
        [{ address: "ana@x.com", name: "" }],
        [
          { address: "bia@y.com", name: "" },
          { address: "jean@mepmail.dev", name: "" },
        ],
        [
          { address: "ANA@x.com", name: "Ana Costa" },
          { address: "no-reply@aws.example", name: "AWS" },
          { address: "noreply@x.com", name: "" },
          { address: "nope", name: "Broken" },
          { address: "carla@z.com", name: " Carla Dias " },
        ],
      ],
      ["jean@mepmail.dev"],
    );
    expect(contacts).toEqual([
      { address: "ana@x.com", name: "Ana Costa" },
      { address: "bia@y.com", name: "" },
      { address: "carla@z.com", name: "Carla Dias" },
    ]);
  });

  it("matches the start of an address or name word first and skips chosen ones", () => {
    const contacts = [
      { address: "marcos@x.com", name: "" },
      { address: "ana@mar.com", name: "" },
      { address: "julia@y.com", name: "Julia Martins" },
      { address: "mariana@x.com", name: "Mariana Costa" },
    ];
    expect(matchContacts(contacts, "mar", []).map((c) => c.address)).toEqual([
      "marcos@x.com",
      "julia@y.com",
      "mariana@x.com",
      "ana@mar.com",
    ]);
    expect(matchContacts(contacts, "MAR", ["Marcos@x.com"]).map((c) => c.address)).toEqual([
      "julia@y.com",
      "mariana@x.com",
      "ana@mar.com",
    ]);
    expect(matchContacts(contacts, "  ", [])).toEqual([]);
  });
});
