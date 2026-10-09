import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function headers(enabled: string, pixel = "1418150576403119") {
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ENABLED", enabled);
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", pixel);
  vi.stubEnv("NODE_ENV", "production");
  const config = (await import("../next.config")).default;
  return (await config.headers?.()) ?? [];
}

describe("public Meta Content Security Policy", () => {
  it.each(["", "false", "1"])("retains the existing policy for disabled flag %s", async (flag) => {
    const rules = await headers(flag);
    expect(rules).toHaveLength(2);
    expect(JSON.stringify(rules)).not.toContain("facebook");
  });

  it("adds the Google tag hosts to public documents only, alone or beside the Pixel", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_TAG_ENABLED", "true");
    for (const rules of [await headers(""), await headers("true")]) {
      expect(rules.map((rule) => rule.source)).toEqual([
        "/:path*",
        "/support",
        "/",
        "/pricing",
        "/correio",
      ]);
      const csp = (source: string) =>
        rules
          .find((rule) => rule.source === source)
          ?.headers.find((item) => item.key === "Content-Security-Policy")?.value ?? "";
      expect(csp("/:path*")).not.toContain("google");
      expect(csp("/support")).not.toContain("google");
      for (const source of ["/", "/pricing", "/correio"]) {
        expect(csp(source)).toContain("https://www.googletagmanager.com");
        expect(csp(source)).toContain("https://*.google-analytics.com");
        expect(csp(source)).toContain("https://*.analytics.google.com");
        expect(csp(source)).toContain("frame-ancestors 'none'");
      }
    }
    expect(JSON.stringify(await headers(""))).not.toContain("facebook");
  });
  it("lets the desktop shell reach its IPC origins from every route's connect-src", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_TAG_ENABLED", "true");
    for (const rule of await headers("true")) {
      const csp = rule.headers.find((item) => item.key === "Content-Security-Policy")?.value ?? "";
      const connect = csp.split("; ").find((part) => part.startsWith("connect-src")) ?? "";
      expect(connect, rule.source).toContain("ipc: http://ipc.localhost https://ipc.localhost");
      expect(csp, rule.source).not.toContain("script-src 'self' ipc:");
    }
  });
  it("rejects a malformed dataset and never broadens private paths", async () => {
    expect(await headers("true", "bad; https://untrusted.invalid")).toHaveLength(2);
  });

  it("overrides only public offer documents, retaining the other protections", async () => {
    const rules = await headers("true");
    expect(rules.map((rule) => rule.source)).toEqual([
      "/:path*",
      "/support",
      "/",
      "/pricing",
      "/correio",
    ]);
    const original = rules[0]?.headers ?? [];
    expect(original.find((item) => item.key === "Content-Security-Policy")?.value).not.toContain(
      "facebook",
    );
    expect(original.find((item) => item.key === "X-Frame-Options")?.value).toBe("DENY");
    for (const rule of rules.filter((rule) =>
      ["/", "/pricing", "/correio"].includes(rule.source),
    )) {
      const csp = rule.headers.find((item) => item.key === "Content-Security-Policy")?.value ?? "";
      expect(csp).toContain("https://connect.facebook.net");
      expect(csp).toContain("https://www.facebook.com");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("https://challenges.cloudflare.com");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(rule.headers.find((item) => item.key === "Referrer-Policy")?.value).toBe(
        "no-referrer",
      );
    }
  });
});
