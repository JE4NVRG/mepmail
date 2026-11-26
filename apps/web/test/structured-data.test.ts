import { describe, expect, it } from "vitest";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import {
  breadcrumbJsonLd,
  correioJsonLd,
  desktopAppJsonLd,
  faqJsonLd,
  jsonLdDocument,
  organizationJsonLd,
  sendingApiJsonLd,
  websiteJsonLd,
} from "@/lib/structured-data";

const base = "https://mepmail.dev";

describe("schema.org graph of the public pages", () => {
  it("names the publisher once and links the site and the products to it", () => {
    const org = organizationJsonLd(base);
    expect(org).toMatchObject({
      "@type": "Organization",
      "@id": `${base}/#organization`,
      logo: `${base}/logo/mepmail-logo-400.png`,
      email: "suporte@mepmail.dev",
    });
    expect(org.sameAs).toEqual(
      expect.arrayContaining([
        "https://github.com/JE4NVRG/mepmail",
        "https://www.npmjs.com/package/@mepmail/mcp",
        "https://glama.ai/mcp/servers/JE4NVRG/mepmail",
      ]),
    );
    expect(websiteJsonLd(base, "pt-BR")).toMatchObject({
      inLanguage: "pt-BR",
      publisher: { "@id": `${base}/#organization` },
    });
    expect(sendingApiJsonLd(base, `${base}/envio`, "Sending API")).toMatchObject({
      "@type": "SoftwareApplication",
      name: "MepMail Send",
      applicationCategory: "DeveloperApplication",
      publisher: { "@id": `${base}/#organization` },
    });
    expect(
      breadcrumbJsonLd(base, [
        { name: "MepMail", path: "/" },
        { name: "Integrations", path: "/integrations" },
      ]),
    ).toMatchObject({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "MepMail", item: `${base}/` },
        { "@type": "ListItem", position: 2, name: "Integrations", item: `${base}/integrations` },
      ],
    });
  });

  it("prices Correio from its smallest plan, in dollars and in reais", () => {
    const smallest = Math.min(...LAUNCH_OFFER.correioPlans.map((plan) => plan.monthlyCents));
    const plan = LAUNCH_OFFER.correioPlans.find((p) => p.monthlyCents === smallest);
    const app = correioJsonLd(base, `${base}/correio?lang=pt-BR`, "E-mail corporativo");
    expect(app.offers).toEqual([
      { "@type": "Offer", price: (smallest / 100).toFixed(2), priceCurrency: "USD" },
      {
        "@type": "Offer",
        price: ((plan?.brlMonthlyCents ?? 0) / 100).toFixed(2),
        priceCurrency: "BRL",
      },
    ]);
    expect(app.url).toBe(`${base}/correio?lang=pt-BR`);
    expect(desktopAppJsonLd(base, `${base}/download`, "App", "1.0.2")).toMatchObject({
      softwareVersion: "1.0.2",
      offers: { price: "0" },
    });
  });

  it("carries the FAQ as the page shows it, and never lets copy close the script", () => {
    const faq = faqJsonLd([{ q: "Funciona com </script>?", a: "Sim <b>sempre</b>." }]);
    expect(faq).toMatchObject({
      "@type": "FAQPage",
      mainEntity: [
        { name: "Funciona com </script>?", acceptedAnswer: { text: "Sim <b>sempre</b>." } },
      ],
    });
    const doc = jsonLdDocument([faq]);
    expect(doc).not.toContain("<");
    expect(JSON.parse(doc)).toMatchObject({ "@context": "https://schema.org", "@graph": [faq] });
  });
});
