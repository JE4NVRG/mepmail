import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOME_STACK_LOGOS,
  HOME_STACK_SLUGS,
  logoSrc,
  MCP_CHIP,
  STACK_LOGOS,
  STACK_SLUGS,
  stackLogo,
} from "../src/lib/stack-logos";

// The logo bands render vendored files, never a hotlink: a 404 here is a broken
// mark on the home strip and on /integrations, which no build step would catch.
// MCP is the one entry with no vendor logo — its chip belongs inside the card
// that talks about MCP, never on a band of real brand marks.
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

/** Hex colours declared by a file, normalised to lowercase #rrggbb. */
function inks(svg: string): string[] {
  const found = new Set<string>();
  for (const match of svg.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    const raw = match[1] ?? "";
    const hex = raw.length === 3 ? raw.replace(/./g, (c) => c + c) : raw;
    if (hex) found.add(`#${hex.toLowerCase()}`);
  }
  return [...found];
}

function isChromatic(hex: string): boolean {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) > 24;
}

describe("integration logo wall", () => {
  it("vendors every mark as a local SVG with a viewBox and no scripting", () => {
    for (const logo of STACK_LOGOS) {
      const file = join(publicDir, logoSrc(logo.slug));
      expect(existsSync(file), `${logo.slug} → ${file}`).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg, logo.slug).toMatch(/viewBox="[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+"/);
      expect(svg, logo.slug).not.toMatch(/<script|<image|href="http/i);
    }
  });

  it("keeps every mark in the vendor's own colour, not a grey glyph", () => {
    // The rejected wall was monochrome #4a4a4a: illegible on near-black and
    // unidentifiable. Each mark must carry at least one chromatic ink.
    for (const logo of STACK_LOGOS) {
      const svg = readFileSync(join(publicDir, logoSrc(logo.slug)), "utf8");
      const declared = inks(svg);
      expect(declared.length, `${logo.slug} has no colour at all`).toBeGreaterThan(0);
      expect(
        declared.some(isChromatic),
        `${logo.slug} declares only greys: ${declared.join(", ")}`,
      ).toBe(true);
    }
  });

  it("normalises marks by height, with a ratio that matches each file's viewBox", () => {
    for (const logo of STACK_LOGOS) {
      const svg = readFileSync(join(publicDir, logoSrc(logo.slug)), "utf8");
      const viewBox = svg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)"/);
      expect(viewBox, logo.slug).not.toBeNull();
      const width = Number(viewBox?.[3]);
      const height = Number(viewBox?.[4]);
      expect(logo.ratio, logo.slug).toBeCloseTo(width / height, 2);
      // A square would squash a wide lockup and a very wide mark would break
      // the band's rhythm: both ends are checked at the 28px strip size.
      expect(logo.ratio, logo.slug).toBeGreaterThanOrEqual(0.9);
      expect(logo.ratio, logo.slug).toBeLessThanOrEqual(4.6);
      expect(Math.round(28 * logo.ratio), logo.slug).toBeLessThanOrEqual(130);
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

  it("never mixes the MCP text chip into a band of brand marks", () => {
    for (const band of [HOME_STACK_SLUGS, STACK_SLUGS]) {
      expect(band).not.toContain(MCP_CHIP);
      for (const slug of band) expect(stackLogo(slug), slug).toBeDefined();
    }
  });

  it("draws MCP as text instead of an invented logo", () => {
    expect(stackLogo(MCP_CHIP)).toBeUndefined();
  });
});
