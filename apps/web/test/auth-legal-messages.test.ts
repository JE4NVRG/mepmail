import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enAuth from "../messages/en/auth.json";
import ptAuth from "../messages/pt-BR/auth.json";

// Every auth.legal key the sign-up/sign-in form asks for must exist in both languages: three
// missing ones (updatesRequested/updatesFailed/updatesManage) showed as raw keys on the
// "check your inbox" screen of anyone who ticked product updates.
const form = readFileSync(new URL("../src/components/auth/auth-form.tsx", import.meta.url), "utf8");
const used = new Set<string>();
for (const match of form.matchAll(/tLegal\(\s*([^)]*)\)/g)) {
  for (const literal of match[1]?.matchAll(/"([A-Za-z]+)"/g) ?? []) used.add(literal[1] as string);
}

describe.each([
  ["en", enAuth],
  ["pt-BR", ptAuth],
] as const)("auth.legal keys used by the auth form (%s)", (_locale, messages) => {
  it("finds the keys the form asks for", () => {
    expect(used).toContain("updatesRequested");
    expect(used).toContain("updatesFailed");
    expect(used).toContain("updatesManage");
  });

  it("has a non-empty text for each of them", () => {
    const legal = messages.legal as Record<string, unknown>;
    for (const key of used) {
      const value = legal[key];
      expect(value, key).toBeDefined();
      if (typeof value === "string") expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });
});
