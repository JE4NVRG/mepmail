import { afterEach, expect, it, vi } from "vitest";
import { assertEnvConsistency, type Env, resolveOAuthIssuerUrl } from "../src/env.js";

const WEB = "https://mepmail.dev";
const ISSUER = "https://mepmail.je4ndev.com";
const API = "https://api-mepmail.je4ndev.com";
afterEach(() => vi.unstubAllEnvs());

it("preserves the existing issuer by default, including the local quickstart", () => {
  expect(resolveOAuthIssuerUrl(ISSUER, undefined, undefined)).toBe(ISSUER);
  expect(resolveOAuthIssuerUrl("http://localhost:3000", undefined, undefined)).toBe(
    "http://localhost:3000",
  );
});
it("requires an explicit public API URL for a decoupled issuer", () => {
  expect(() => resolveOAuthIssuerUrl(WEB, ISSUER, undefined)).toThrow(/PUBLIC_API_URL/);
  expect(() =>
    assertEnvConsistency({ APP_BASE_URL: WEB, OAUTH_ISSUER_URL: ISSUER } as Env),
  ).toThrow(/PUBLIC_API_URL/);
  expect(resolveOAuthIssuerUrl(WEB, ISSUER, API)).toBe(ISSUER);
});
it.each([
  "/relative",
  "not a URL",
  "ftp://example.com",
  "https://user:pass@example.com",
  "https://example.com/path",
  "https://example.com/",
  "https://example.com?query",
  "https://example.com#fragment",
])("rejects invalid issuer %s", (issuer) => {
  expect(() => resolveOAuthIssuerUrl(WEB, issuer, API)).toThrow(/OAUTH_ISSUER_URL/);
  expect(() =>
    assertEnvConsistency({
      APP_BASE_URL: WEB,
      OAUTH_ISSUER_URL: issuer,
      PUBLIC_API_URL: API,
    } as Env),
  ).toThrow(/OAUTH_ISSUER_URL/);
});
it.each([
  "/relative",
  "not a URL",
  "ftp://example.com",
  "https://user:pass@example.com",
  "https://example.com?query",
  "https://example.com#fragment",
])("rejects invalid explicit API URL %s during migration", (api) => {
  expect(() => resolveOAuthIssuerUrl(WEB, ISSUER, api)).toThrow(/PUBLIC_API_URL/);
});
