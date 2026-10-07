import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("frontend polish contracts", () => {
  for (const locale of ["en", "pt-BR"]) {
    for (const namespace of ["landing", "auth", "pricing", "alternatives", "integrations"]) {
      it(`${locale}/${namespace}: natural editorial punctuation`, () => {
        const text = read(`../messages/${locale}/${namespace}.json`);
        expect(text).not.toContain("—");
        expect(text).not.toMatch(/one.click|1 clique/i);
      });
    }
  }
  it("auth uses one shell, personalization illustration and both home links", () => {
    const shell = read("../src/components/auth/auth-screen.tsx");
    const form = read("../src/components/auth/auth-form.tsx");
    expect(form).toContain('<AuthScreen title={t("title")} panel={mode}>');
    // The source offer lives in the site footer and the dashboard sidebar.
    expect(shell).not.toContain('href="/source"');
    expect(shell.match(/href="\/"/g)).toHaveLength(2);
    expect(shell).toContain("<AuthArt />");
    expect(shell).not.toContain("/product/templates-hero.webp");
    // The landing's proof is the live starter gallery (it replaced the static
    // templates-hero.webp); the auth shell keeps its own illustration.
    expect(read("../src/app/page.tsx")).toContain("<PublicStarterGallery");
    expect(shell).not.toContain("PublicStarterGallery");
    expect(shell).toContain("LandingLangSwitch");
    expect(shell + form).not.toMatch(/SilkCanvas|waves-dark|waves-light/);
    // The redirect goes through postAuthNext, which validates with safeNextPath.
    expect(form).toContain("postAuthNext(nextParam");
    expect(read("../src/lib/nav.ts")).toContain("const next = safeNextPath(");
    expect(form).toContain("callbackURL: verifyCallback");
    expect(form).toContain("errorCallbackURL: withNext(mode");
    expect(form).toContain('params.get("email")');
  });
  it("motion is an enhancement, never a hidden CSS prerequisite", () => {
    const motion = read("../src/components/landing-motion.tsx");
    expect(motion).toContain('typeof IntersectionObserver === "undefined"');
    expect(motion).toContain("!Element.prototype.animate");
    expect(motion).toContain("if (preference.matches) continue");
    expect(motion).toContain("animation.cancel()");
    expect(motion).toContain("observer.disconnect()");
    for (const path of ["../src/app/landing-cro.css", "../src/components/auth/auth.module.css"]) {
      const css = read(path);
      expect(css).toContain("prefers-reduced-motion: reduce");
      expect(css).not.toMatch(/opacity:\s*0[;\s}]/);
      expect(css).not.toContain("infinite");
    }
  });
});
