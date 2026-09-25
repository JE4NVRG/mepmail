import { describe, expect, it } from "vitest";
import { LANGS } from "../../components/api-sheet";
import { onboardingSnippet, SNIPPET_HLJS, SNIPPET_LABELS, SNIPPET_LANGS } from "./snippets";

const P = {
  apiUrl: "https://api-mepmail.agenciamep.com",
  apiKey: "ms_test_key",
  from: "Acme <onboarding@yourdomain.com>",
  to: "delivered@example.com",
  subject: "hello world",
  html: "<h1>it works!</h1>",
  comment: "shown once",
};

/** Languages the SDK itself has to reach without a trailing slash. */
const NO_TRAILING_SLASH = ["python", "rust", "elixir", "node", "php", "dotnet"] as const;
/** Languages that join the base with a relative path and need the slash. */
const NEEDS_TRAILING_SLASH = ["go", "ruby"] as const;

describe("onboardingSnippet", () => {
  it("offers every SDK language, and only those, plus curl", () => {
    expect([...SNIPPET_LANGS]).toEqual([...LANGS, "curl"]);
    for (const lang of SNIPPET_LANGS) {
      expect(SNIPPET_LABELS[lang], `${lang} label`).toEqual(expect.any(String));
      expect(SNIPPET_HLJS[lang], `${lang} highlight`).toEqual(expect.any(String));
    }
  });

  for (const lang of SNIPPET_LANGS) {
    it(`${lang}: carries the account's own values and never upstream's`, () => {
      const code = onboardingSnippet(lang, P);
      expect(code).toContain(P.apiKey);
      expect(code).toContain(P.to);
      expect(code).toContain(P.subject);
      expect(code).toContain(P.html);
      expect(code).toContain(P.comment);
      // No snippet may CALL the public API. Naming it inside a comment to
      // explain why a language can't be repointed is fine — Java does exactly
      // that, and hiding it would make the tab look like it just forgot.
      for (const line of code.split("\n")) {
        if (!line.includes("api.resend.com")) continue;
        const trimmed = line.trim();
        expect(
          trimmed.startsWith("//") || trimmed.startsWith("#"),
          `${lang}: api.resend.com only in a comment, found "${trimmed}"`,
        ).toBe(true);
      }
      expect(code).not.toContain("millionsend");
    });
  }

  it("points every language at this account's API URL", () => {
    for (const lang of SNIPPET_LANGS) {
      expect(onboardingSnippet(lang, P), lang).toContain(P.apiUrl);
    }
  });

  it("appends the trailing slash only where the SDK's URL join requires it", () => {
    for (const lang of NEEDS_TRAILING_SLASH) {
      expect(onboardingSnippet(lang, P), lang).toContain(`${P.apiUrl}/`);
    }
    for (const lang of NO_TRAILING_SLASH) {
      expect(onboardingSnippet(lang, P), lang).not.toContain(`${P.apiUrl}/`);
    }
  });

  it("Java shows the plain HTTP call, since its SDK cannot be repointed", () => {
    const code = onboardingSnippet("java", P);
    expect(code).toContain(`${P.apiUrl}/emails`);
    expect(code).toContain("HttpRequest.newBuilder()");
    // No pretence of a Java client that could carry the base URL.
    expect(code).not.toContain("com.resend");
  });

  it("curl posts to the emails endpoint with bearer auth", () => {
    const code = onboardingSnippet("curl", P);
    expect(code).toContain(`curl -X POST ${P.apiUrl}/emails`);
    expect(code).toContain(`Authorization: Bearer ${P.apiKey}`);
  });
});
