import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMailDelayed, cloudSendingPaused } from "../src/server/ses-pause";

const paused = (region: string) => Promise.resolve(region === "us-east-1");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("account mail delay", () => {
  it("is late only on the cloud, while SES pauses a served region and no SMTP fallback carries it", async () => {
    vi.stubEnv("AWS_REGIONS", "sa-east-1,us-east-1");
    vi.stubEnv("IS_CLOUD", "true");
    vi.stubEnv("SMTP_FALLBACK_URL", "");
    expect(await cloudSendingPaused(paused)).toBe(true);
    expect(await accountMailDelayed(paused)).toBe(true);
    expect(await accountMailDelayed(() => Promise.resolve(false))).toBe(false);
    vi.stubEnv("SMTP_FALLBACK_URL", "smtps://noreply%40example.invalid:x@smtp.example.invalid:465");
    expect(await accountMailDelayed(paused)).toBe(false);
    vi.stubEnv("SMTP_FALLBACK_URL", "");
    vi.stubEnv("IS_CLOUD", "false");
    expect(await accountMailDelayed(paused)).toBe(false);
  });
});
