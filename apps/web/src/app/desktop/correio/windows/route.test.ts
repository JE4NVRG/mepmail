import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import latest from "../../../../../public/desktop/correio/latest.json";
import { GET } from "./route";

const publicDir = fileURLToPath(new URL("../../../../../public/desktop/correio/", import.meta.url));
const tauriConf = fileURLToPath(
  new URL("../../../../../../desktop/src-tauri/tauri.conf.json", import.meta.url),
);

describe("Correio desktop downloads", () => {
  const windows = latest.platforms["windows-x86_64"];

  it("points the download link at the installer latest.json names", () => {
    const response = GET();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(windows.url);
  });

  it("names a signed installer of the same version, served from public", () => {
    expect(latest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const url = new URL(windows.url);
    expect(url.origin).toBe("https://mepmail.dev");
    expect(url.pathname).toBe(`/desktop/correio/MepMail-Correio_${latest.version}_x64-setup.exe`);
    const file = `${publicDir}${url.pathname.split("/").pop()}`;
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(500_000);
    // A minisign signature, base64 of its two-part text form.
    const signature = Buffer.from(windows.signature, "base64").toString("utf8");
    expect(signature).toMatch(/^untrusted comment: /);
    expect(signature).toContain("trusted comment: ");
    expect(Number.isNaN(Date.parse(latest.pub_date))).toBe(false);
  });

  it("is the endpoint the app asks, when the desktop sources sit next to the web app", () => {
    // The Docker image ships apps/web only; the check runs where both exist.
    if (!existsSync(tauriConf)) return;
    const conf = JSON.parse(readFileSync(tauriConf, "utf8")) as {
      version: string;
      plugins: { updater: { endpoints: string[] } };
    };
    expect(conf.plugins.updater.endpoints).toEqual([
      "https://mepmail.dev/desktop/correio/latest.json",
    ]);
  });
});
