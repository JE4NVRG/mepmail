import { afterEach, describe, expect, it, vi } from "vitest";
import { externalOAuthWorks } from "../src/lib/desktop-bridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

const shell = (version: string) =>
  vi.stubGlobal("window", {
    __MEPMAIL_DESKTOP__: { app: "mepmail-correio", version, platform: "windows" },
  });

describe("Contas externas: where the Microsoft/Google sign-in can finish", () => {
  it("works in a browser and from desktop 1.0.3 on", () => {
    vi.stubGlobal("window", {});
    expect(externalOAuthWorks()).toBe(true);
    for (const version of ["1.0.3", "1.0.10", "1.1.0", "2.0.0"]) {
      shell(version);
      expect(externalOAuthWorks()).toBe(true);
    }
  });

  it("is not offered in older desktop apps, which hand the provider to another browser", () => {
    for (const version of ["1.0.2", "1.0.0", "0.3.0", "garbage"]) {
      shell(version);
      expect(externalOAuthWorks()).toBe(false);
    }
  });
});
