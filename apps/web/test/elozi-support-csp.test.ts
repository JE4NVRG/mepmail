import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Elozi support document policy", () => {
  it.each(["production", "development"])(
    "confines script/connect to /support in %s",
    async (env) => {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ENABLED", "true");
      vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "1418150576403119");
      const config = (await import("../next.config")).default;
      const rules = (await config.headers?.()) ?? [];
      const base = rules.find((rule) => rule.source === "/:path*");
      const support = rules.find((rule) => rule.source === "/support");
      const csp = support?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
      expect(csp.split("; ").filter((directive) => directive.includes("elozi"))).toEqual([
        `script-src 'self' 'unsafe-inline'${env === "development" ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com https://umami.je4ndev.com https://elozi.je4ndev.com`,
        "connect-src 'self' https://umami.je4ndev.com https://elozi.je4ndev.com",
      ]);
      for (const rule of rules.filter((rule) => rule.source !== "/support")) {
        expect(JSON.stringify(rule)).not.toContain("elozi");
      }
      expect(base?.headers.find((h) => h.key === "Permissions-Policy")?.value).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      );
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-src https://challenges.cloudflare.com;");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("media-src 'self'");
    },
  );
});
