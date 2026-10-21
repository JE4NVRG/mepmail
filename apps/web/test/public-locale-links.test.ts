import { describe, expect, it } from "vitest";
import { linkHrefInLocale } from "../src/lib/public-locale-url";

const page = new URL("https://mepmail.dev/?lang=pt-BR");
const href = (link: string, locale: "en" | "pt-BR" = "pt-BR") =>
  linkHrefInLocale(new URL(link, page), page, locale);

describe("links keep the page's language (QA F1)", () => {
  it("adds ?lang=pt-BR to public pages, keeping query and hash", () => {
    expect(href("/envio")).toBe("/envio?lang=pt-BR");
    expect(href("/pricing#correio")).toBe("/pricing?lang=pt-BR#correio");
    expect(href("/correio?utm_source=x")).toBe("/correio?utm_source=x&lang=pt-BR");
    expect(href("/terms/")).toBe("/terms/?lang=pt-BR");
  });

  it("carries the language into sign-up and login", () => {
    expect(href("/signup?next=/mail")).toBe("/signup?next=%2Fmail&lang=pt-BR");
    expect(href("/login")).toBe("/login?lang=pt-BR");
  });

  it("leaves English, other origins, explicit languages and private routes alone", () => {
    expect(href("/envio", "en")).toBeNull();
    expect(href("https://docs.mepmail.dev/")).toBeNull();
    expect(href("/envio?lang=en")).toBeNull();
    expect(href("/mail")).toBeNull();
    expect(href("/api/version")).toBeNull();
  });
});
