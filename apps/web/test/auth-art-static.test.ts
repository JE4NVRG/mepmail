import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuthArt } from "../src/components/auth/auth-art";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
const path = (value: string) => fileURLToPath(new URL(value, import.meta.url));

describe("authentication illustration", () => {
  it("draws the template and both personal messages in the page's language", () => {
    const tree = nodes(AuthArt());
    const frame = tree.find((node) => node.props.role === "img");
    expect(frame?.props["aria-label"]).toBe("artAlt");
    const text = JSON.stringify(tree.map((node) => node.props.children));
    expect(text).toContain("FIRST_NAME");
    for (const key of ["art.hello", "art.subject", "art.line1", "art.line2", "art.cta"]) {
      expect(text).toContain(key);
    }
    expect(text).toMatch(/Ana[\s\S]*Sam/);
    expect(tree.find((node) => node.type === "figcaption")?.props.children).toBe("artCaption");
    expect(tree.some((node) => ["video", "button", "img", "picture"].includes(String(node.type)))).toBe(false);
  });

  it("needs no asset, video or playback code", () => {
    expect(existsSync(path("../public/product/auth-personalization.mp4"))).toBe(false);
    const source = readFileSync(path("../src/components/auth/auth-art.tsx"), "utf8");
    expect(source).not.toMatch(/useEffect|useState|useRef|playback|\.mp4|<video|\.webp/);
    const css = readFileSync(path("../src/components/auth/auth.module.css"), "utf8");
    expect(css).toMatch(/@media \(max-width: 959px\)[\s\S]*?\.product\s*\{\s*display: none/);
    expect(css).not.toMatch(/artControl|\.artFrame video/);
    for (const locale of ["en", "pt-BR"]) {
      const messages = JSON.parse(readFileSync(path(`../messages/${locale}/auth.json`), "utf8"));
      expect(messages.shell.artAlt).toContain("Ana");
      expect(messages.shell).not.toHaveProperty("pauseAnimation");
      expect(messages.shell).not.toHaveProperty("playAnimation");
    }
  });
});
