import { describe, expect, it } from "vitest";
import { hasOneClickUnsubscribe } from "../src/handlers/send-email.js";

const valid = {
  "List-Unsubscribe": "<https://sender.example.invalid/unsubscribe/opaque>",
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};

describe("closed API campaign one-click MIME guard", () => {
  it("accepts an HTTPS one-click pair and preserves header case independence", () => {
    expect(hasOneClickUnsubscribe(valid)).toBe(true);
    expect(
      hasOneClickUnsubscribe({
        "list-unsubscribe": valid["List-Unsubscribe"],
        "list-unsubscribe-post": valid["List-Unsubscribe-Post"],
      }),
    ).toBe(true);
  });
  it("accepts an additional mailto option without changing the HTTPS endpoint", () => {
    expect(
      hasOneClickUnsubscribe({
        ...valid,
        "List-Unsubscribe":
          "<https://sender.example.invalid/unsubscribe>, <mailto:unsubscribe@example.invalid>",
      }),
    ).toBe(true);
  });
  const invalidCases: Record<string, string>[] = [
    {},
    { "List-Unsubscribe": valid["List-Unsubscribe"] },
    { ...valid, "List-Unsubscribe": "<mailto:unsubscribe@example.invalid>" },
    { ...valid, "List-Unsubscribe": "<http://sender.example.invalid/unsubscribe>" },
    { ...valid, "List-Unsubscribe": "<https://user:pass@sender.example.invalid/unsubscribe>" },
    { ...valid, "List-Unsubscribe": "<https://sender.example.invalid/unsubscribe#fragment>" },
    {
      ...valid,
      "List-Unsubscribe": "<https://sender.example.invalid/a><https://sender.example.invalid/b>",
    },
    { ...valid, "List-Unsubscribe": "junk <https://sender.example.invalid/unsubscribe>" },
    { ...valid, "list-unsubscribe": valid["List-Unsubscribe"] },
    { ...valid, "List-Unsubscribe-Post": "wrong" },
    { ...valid, "List-Unsubscribe-Post": "\r\nList-Unsubscribe=One-Click" },
    {
      ...valid,
      "List-Unsubscribe": "<https://sender.example.invalid/unsubscribe>\r\nX-Injected: yes",
    },
  ];
  it.each(invalidCases)(
    "rejects absent, partial, ambiguous or unsafe one-click headers (%#)",
    (headers) => {
      expect(hasOneClickUnsubscribe(headers)).toBe(false);
    },
  );
});
