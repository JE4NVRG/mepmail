import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GUIDE_SLUGS, type GuideCopy } from "@/lib/guides";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import enGuides from "../messages/en/guides.json";
import enLanding from "../messages/en/landing.json";
import ptGuides from "../messages/pt-BR/guides.json";
import ptLanding from "../messages/pt-BR/landing.json";

type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "pt-BR" as Locale }));
const messages = (locale: Locale) =>
  locale === "en"
    ? { guides: enGuides, landing: enLanding }
    : { guides: ptGuides, landing: ptLanding };

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "guides" | "landing") =>
    createTranslator({ locale: current.locale, messages: messages(current.locale), namespace }),
}));
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
  SignupLink: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));

const { default: GuidePage, generateMetadata } = await import("../src/app/guides/[slug]/page");
const { default: GuidesIndex } = await import("../src/app/guides/page");

const copyOf = (locale: Locale, slug: string) =>
  (locale === "en" ? enGuides : ptGuides).items[slug as keyof typeof enGuides.items] as GuideCopy;

async function render(node: Promise<ReturnType<typeof createElement>>) {
  const children = await node;
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: current.locale,
      messages: messages(current.locale),
      children,
    }),
  );
}

describe("public guides", () => {
  it("has every guide in both languages, with the same shape and search-sized metadata", () => {
    for (const slug of GUIDE_SLUGS) {
      const pt = copyOf("pt-BR", slug);
      const en = copyOf("en", slug);
      expect(pt.sections.length, slug).toBe(en.sections.length);
      expect(pt.faq.length, slug).toBe(en.faq.length);
      for (const copy of [pt, en]) {
        expect(`${copy.meta.title} | MepMail`.length, slug).toBeLessThanOrEqual(80);
        expect(copy.meta.description.length, slug).toBeLessThanOrEqual(155);
      }
    }
    expect(Object.keys(ptGuides.items).sort()).toEqual([...GUIDE_SLUGS].sort());
    expect(Object.keys(enGuides.items).sort()).toEqual([...GUIDE_SLUGS].sort());
  });

  it("quotes the Correio and Envio prices the offer actually has", () => {
    const solo = LAUNCH_OFFER.correioPlans.find((plan) => plan.id === "solo");
    const brl = ((solo?.brlMonthlyCents ?? 0) / 100).toFixed(2).replace(".", ",");
    const usd = ((solo?.monthlyCents ?? 0) / 100).toFixed(2);
    const ptText = JSON.stringify(ptGuides);
    const enText = JSON.stringify(enGuides);
    expect(ptText).toContain(`R$ ${brl}`);
    expect(enText).toContain(`US$ ${usd}`);
    expect(enText).toContain(`US$ ${LAUNCH_OFFER.sending.monthlyCents / 100}`);
    expect(ptText).toContain(`${LAUNCH_OFFER.correioTrialDays} dias grátis`);
  });

  for (const locale of ["pt-BR", "en"] as const) {
    it(`renders each guide in ${locale} with its Article and FAQ data`, async () => {
      current.locale = locale;
      for (const slug of GUIDE_SLUGS) {
        const params = Promise.resolve({ slug });
        const html = await render(GuidePage({ params }));
        const copy = copyOf(locale, slug);
        expect(html).toContain(copy.title);
        expect(html).toContain(copy.cta.title);
        const graph = JSON.parse(
          html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1] ?? "{}",
        );
        expect(graph["@graph"].map((node: { "@type": string }) => node["@type"])).toEqual([
          "Organization",
          "Article",
          "FAQPage",
        ]);
        const metadata = await generateMetadata({ params: Promise.resolve({ slug }) });
        expect(metadata.title).toEqual({ absolute: `${copy.meta.title} | MepMail` });
        expect(metadata.alternates?.languages).toMatchObject({
          "pt-BR": `/guides/${slug}?lang=pt-BR`,
          "x-default": `/guides/${slug}`,
        });
      }
      const index = await render(GuidesIndex());
      for (const slug of GUIDE_SLUGS) expect(index).toContain(`href="/guides/${slug}"`);
    });
  }

  it("answers 404 for a guide that does not exist", async () => {
    await expect(GuidePage({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
