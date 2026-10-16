import { formatUrl } from "next/dist/shared/lib/router/utils/format-url";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";
import { describe, expect, it } from "vitest";
import config from "../next.config";

describe("Portuguese public aliases", () => {
  it.each([
    ["/precos", "/pricing"],
    ["/termos", "/terms"],
    ["/privacidade", "/privacy"],
    ["/cadastro", "/signup"],
    ["/contato", "/support"],
  ])(
    "keeps %s Portuguese without losing existing query or duplicating lang",
    async (source, target) => {
      const redirects = await config.redirects?.();
      const rule = redirects?.find((item) => item.source === source);
      expect(rule?.permanent).toBe(true);
      expect(rule?.destination).toBe(`${target}?lang=pt-BR`);
      for (const lang of [undefined, "en", ["en", "pt-BR"]]) {
        const { parsedDestination } = prepareDestination({
          destination: rule?.destination ?? "",
          params: {},
          query: {
            utm_source: "fixture",
            next: "/templates/new?starter=welcome",
            ...(lang ? { lang } : {}),
          },
          appendParamsToQuery: false,
        });
        // Next's redirect resolver clears search after merging destination.query.
        const url = new URL(formatUrl({ ...parsedDestination, search: "" }), "https://mepmail.dev");
        expect(url.pathname).toBe(target);
        expect(url.searchParams.getAll("lang")).toEqual(["pt-BR"]);
        expect(url.searchParams.get("utm_source")).toBe("fixture");
        expect(url.searchParams.get("next")).toBe("/templates/new?starter=welcome");
      }
    },
  );
});
