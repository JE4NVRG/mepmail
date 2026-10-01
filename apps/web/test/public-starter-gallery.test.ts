import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: "pt-BR" }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => h.locale,
  getTranslations: async () => (key: string) => key,
}));
const { PublicStarterGallery } = await import("@/components/public-starter-gallery");
describe("public starters and editor intent", () => {
  it("links all ten real starters to drafts with sandboxed previews", async () => {
    const markup = renderToStaticMarkup(await PublicStarterGallery({}));
    expect(markup.match(/href="\/templates\/new\?starter=/g)).toHaveLength(10);
    expect(markup.match(/sandbox=""/g)).toHaveLength(10);
    expect(markup).toContain("Boas-vindas");
    expect(markup).not.toContain("templates-gallery.webp");
  });
  it("shows four actionable hero models in the current locale", async () => {
    h.locale = "en";
    const markup = renderToStaticMarkup(await PublicStarterGallery({ compact: true }));
    expect(markup.match(/href="\/templates\/new\?starter=/g)).toHaveLength(4);
    expect(markup).toContain("Welcome");
    expect(markup).toContain("starter=shipping-update");
    h.locale = "pt-BR";
  });
});
