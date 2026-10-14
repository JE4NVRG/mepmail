import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const links = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../public/.well-known/assetlinks.json", import.meta.url)),
    "utf8",
  ),
) as {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
}[];

describe("Android app (Trusted Web Activity) ↔ mepmail.dev", () => {
  it("lets the MepMail app open mepmail.dev full screen, by its signing certificates", () => {
    const entry = links.find((link) => link.target.package_name === "dev.mepmail.correio");
    expect(entry?.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(entry?.target.namespace).toBe("android_app");
    expect(entry?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
    for (const fingerprint of entry?.target.sha256_cert_fingerprints ?? [])
      expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
