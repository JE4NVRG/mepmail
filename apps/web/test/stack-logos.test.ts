import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOME_STACK_LOGOS,
  logoSrc,
  MCP_CHIP,
  STACK_LOGOS,
  stackLogo,
} from "../src/lib/stack-logos";

// The public logo wall renders vendored files, never a hotlink: a 404 here is a
// broken mark on the home strip and on /integrations, which no build step would
// catch. MCP is the one entry with no vendor logo — it must keep drawing text.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

describe("integration logo wall", () => {
  it("vendors every mark as a white SVG under public/logos/integrations", () => {
    for (const logo of STACK_LOGOS) {
      const file = join(publicDir, logoSrc(logo.slug));
      expect(existsSync(file), `${logo.slug} → ${file}`).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg, logo.slug).toContain('viewBox="0 0 24 24"');
      expect(svg, logo.slug).toContain('fill="#ffffff"');
      expect(svg, logo.slug).not.toMatch(/<script|<image|href="http/i);
    }
  });

  it("covers the surfaces we actually ship", () => {
    const slugs = STACK_LOGOS.map((logo) => logo.slug);
    // n8n node, chat channels, SDK languages, self-host and the raw API.
    for (const expected of ["n8n", "slack", "discord", "telegram", "docker", "curl"]) {
      expect(slugs, expected).toContain(expected);
    }
  });

  it("keeps the home strip between 8 and 10 marks", () => {
    expect(HOME_STACK_LOGOS.length).toBeGreaterThanOrEqual(8);
    expect(HOME_STACK_LOGOS.length).toBeLessThanOrEqual(10);
  });

  it("keeps one label per mark, short enough for the strip", () => {
    const slugs = STACK_LOGOS.map((logo) => logo.slug);
    const names = STACK_LOGOS.map((logo) => logo.name.trim());
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(24);
  });

  it("draws MCP as text instead of an invented logo", () => {
    expect(stackLogo(MCP_CHIP)).toBeUndefined();
  });
});
