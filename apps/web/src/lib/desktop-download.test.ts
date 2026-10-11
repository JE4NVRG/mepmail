import { describe, expect, it } from "vitest";
import { desktopAppFor } from "./desktop-download";

const agents = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  ubuntuFirefox: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 16328.55.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
};

describe("desktopAppFor", () => {
  it("offers the Windows app in Windows browsers and the Linux app in Linux browsers", () => {
    expect(desktopAppFor(agents.windows, false)).toBe("windows");
    expect(desktopAppFor(agents.ubuntuFirefox, false)).toBe("linux");
    expect(desktopAppFor(agents.linuxChrome, false)).toBe("linux");
  });

  it("offers nothing on phones, Macs, ChromeOS or inside the app", () => {
    expect(desktopAppFor(agents.android, false)).toBeNull();
    expect(desktopAppFor(agents.mac, false)).toBeNull();
    expect(desktopAppFor(agents.chromeOs, false)).toBeNull();
    expect(desktopAppFor(agents.windows, true)).toBeNull();
    expect(desktopAppFor(agents.linuxChrome, true)).toBeNull();
  });
});
