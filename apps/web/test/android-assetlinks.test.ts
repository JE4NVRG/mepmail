import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANDROID_APP_PACKAGE, ANDROID_APP_PACKAGES } from "@/lib/android-app";

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
  it.each(ANDROID_APP_PACKAGES)(
    "lets the MepMail app (%s) open mepmail.dev full screen, by its signing certificates",
    (pkg) => {
      const entry = links.find((link) => link.target.package_name === pkg);
      expect(entry?.relation).toContain("delegate_permission/common.handle_all_urls");
      expect(entry?.target.namespace).toBe("android_app");
      expect(entry?.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
      for (const fingerprint of entry?.target.sha256_cert_fingerprints ?? [])
        expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    },
  );

  it("lists the Play App Signing key of the published app (dev.mepmail.app)", () => {
    const entry = links.find((link) => link.target.package_name === ANDROID_APP_PACKAGE);
    expect(entry?.target.sha256_cert_fingerprints).toContain(
      "38:12:07:21:9B:32:EA:9D:34:D4:D4:F6:F6:09:01:33:17:34:1A:9B:4F:08:2C:72:42:75:34:9B:16:9A:57:32",
    );
  });
});
