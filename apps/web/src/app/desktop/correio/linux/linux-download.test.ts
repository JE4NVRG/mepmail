import { describe, expect, it } from "vitest";
import latest from "../../../../../public/desktop/correio/latest.json";
import { GET as appimage } from "./appimage/route";
import { GET as deb } from "./deb/route";
import { LINUX_PLATFORMS, type LinuxBundle, linuxFile } from "./linux-download";
import { GET as rpm } from "./rpm/route";

const release = `https://github.com/JE4NVRG/mepmail/releases/download/desktop-v${latest.version}/`;
const names: Record<LinuxBundle, string> = {
  appimage: `MepMail_${latest.version}_amd64.AppImage`,
  deb: `MepMail_${latest.version}_amd64.deb`,
  rpm: `MepMail-${latest.version}-1.x86_64.rpm`,
};

describe("Correio Linux downloads", () => {
  it.each([
    ["appimage", appimage],
    ["deb", deb],
    ["rpm", rpm],
  ] as const)(
    "/desktop/correio/linux/%s answers with the file latest.json names",
    (bundle, get) => {
      const response = get();
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(release + names[bundle]);
      expect(linuxFile(bundle).name).toBe(names[bundle]);
    },
  );

  it("signs every Linux bundle for the updater, at the manifest's version", () => {
    for (const platform of Object.values(LINUX_PLATFORMS)) {
      const entry = latest.platforms[platform];
      // A minisign signature, base64 of its text form; the trusted comment
      // names the file and the version it was made for.
      const signature = Buffer.from(entry.signature, "base64").toString("utf8");
      expect(signature).toMatch(/^untrusted comment: /);
      expect(signature).toContain(`file:${entry.url.slice(entry.url.lastIndexOf("/") + 1)}`);
      expect(signature).toContain(`version:${latest.version}`);
    }
  });
});
