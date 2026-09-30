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

describe("static authentication illustration", () => {
  it("renders only the approved responsive image and caption without browser globals", () => {
    const tree = nodes(AuthArt());
    expect(tree.find((node) => node.type === "source")?.props).toMatchObject({
      media: "(min-width: 960px)",
      srcSet: "/product/auth-personalization.webp",
      type: "image/webp",
    });
    expect(tree.find((node) => node.type === "img")?.props).toMatchObject({
      width: 960,
      height: 960,
      alt: "artAlt",
    });
    expect(tree.find((node) => node.type === "img")?.props.src).toMatch(/^data:image\/gif;/);
    expect(tree.find((node) => node.type === "figcaption")?.props.children).toBe("artCaption");
    expect(tree.some((node) => node.type === "video" || node.type === "button")).toBe(false);
  });

  it("keeps the static asset, removes the public video and playback code", () => {
    expect(existsSync(path("../public/product/auth-personalization.webp"))).toBe(true);
    expect(existsSync(path("../public/product/auth-personalization.mp4"))).toBe(false);
    const source = readFileSync(path("../src/components/auth/auth-art.tsx"), "utf8");
    expect(source).not.toMatch(/useEffect|useState|useRef|playback|\.mp4|<video/);
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
