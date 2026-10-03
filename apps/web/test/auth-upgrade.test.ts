import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { legacyAccountIssuer } from "@/lib/legacy-account-issuer";

const SECRET = "fictitious-auth-upgrade-proof-key-only";

async function signedQuery(exp = Math.floor(Date.now() / 1000) + 600) {
  const query = new URLSearchParams({
    client_id: "fixture-client",
    scope: "offline_access",
    exp: String(exp),
  });
  const canonical = new URLSearchParams(
    [...query.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  query.set("sig", await makeSignature(canonical.toString(), SECRET));
  return query;
}

describe("identities compatible with the preserved 1.7.2 artifact", () => {
  it.each([
    ["credential", "local:credential"],
    ["google", "https://accounts.google.com"],
    ["github", "local:oauth:github"],
  ])("writes the legacy issuer for %s", (provider, issuer) => {
    expect(legacyAccountIssuer(provider)).toBe(issuer);
  });

  it.each(["", "__proto__", "toString", "unconfigured"])(
    "refuses an unsupported provider %s",
    (provider) =>
      expect(() => legacyAccountIssuer(provider)).toThrow("Unsupported account provider"),
  );
});

describe("signed authorization before displaying custom consent", () => {
  it("accepts a current signature from the provider", async () => {
    const query = await signedQuery();
    expect(await verifyOAuthQueryParams(query.toString(), SECRET)).toBe(true);
  });

  it("rejects a changed client or scope", async () => {
    for (const [key, value] of [
      ["client_id", "other-client"],
      ["scope", "openid"],
    ] as const) {
      const query = await signedQuery();
      query.set(key, value);
      expect(await verifyOAuthQueryParams(query.toString(), SECRET)).toBe(false);
    }
  });

  it("rejects a valid but expired signature", async () => {
    const query = await signedQuery(Math.floor(Date.now() / 1000) - 60);
    expect(await verifyOAuthQueryParams(query.toString(), SECRET)).toBe(false);
  });

  it("preserves and rejects duplicate signatures", async () => {
    const query = await signedQuery();
    query.append("sig", query.get("sig") ?? "");
    expect(await verifyOAuthQueryParams(query.toString(), SECRET)).toBe(false);
  });

  it("rejects unsigned input without requesting client data", async () => {
    expect(
      await verifyOAuthQueryParams("client_id=fixture-client&scope=offline_access", SECRET),
    ).toBe(false);
  });
});
