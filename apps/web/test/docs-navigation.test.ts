import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/en/quickstart" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useParams: () => ({ lang: "en" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { DocsProvider, publicDocsPathname } from "../../docs/src/components/docs-provider";

const requireDocs = createRequire(new URL("../../docs/package.json", import.meta.url));
const { usePathname } = await import(
  pathToFileURL(requireDocs.resolve("fumadocs-core/framework")).href
);

function PathProbe() {
  return createElement("span", null, usePathname());
}

describe("docs navigation across the default-locale rewrite", () => {
  beforeEach(() => {
    navigation.pathname = "/en/quickstart";
  });

  it.each([
    ["/en", "/"],
    ["/en/", "/"],
    ["/en/quickstart", "/quickstart"],
    ["/en/api-reference/endpoints/emails/post", "/api-reference/endpoints/emails/post"],
    ["/quickstart", "/quickstart"],
    ["/pt-BR/quickstart", "/pt-BR/quickstart"],
    ["/enough", "/enough"],
    ["/english/quickstart", "/english/quickstart"],
  ])("maps %s to the public path %s", (input, expected) => {
    expect(publicDocsPathname(input)).toBe(expected);
  });

  it("provides the same path for prerendered and browser URLs", () => {
    const render = () =>
      renderToString(
        createElement(
          DocsProvider,
          { search: { enabled: false }, theme: { enabled: false } },
          createElement(PathProbe),
        ),
      );
    const prerendered = render();
    navigation.pathname = "/quickstart";
    expect(render()).toBe(prerendered);
    expect(prerendered).toContain(">/quickstart</span>");
  });
});

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
