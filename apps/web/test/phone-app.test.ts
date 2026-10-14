import { describe, expect, it } from "vitest";
import { phoneAppFor } from "../src/lib/phone-app";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("Correio on the home screen: which phone to explain", () => {
  it("explains the iPhone and Android ways in their browsers", () => {
    expect(phoneAppFor(IPHONE, false)).toBe("ios");
    expect(phoneAppFor(ANDROID, false)).toBe("android");
  });

  it("offers nothing on a computer or once it runs from the home screen", () => {
    expect(phoneAppFor(WINDOWS, false)).toBeNull();
    expect(phoneAppFor(IPHONE, true)).toBeNull();
    expect(phoneAppFor(ANDROID, true)).toBeNull();
  });
});
