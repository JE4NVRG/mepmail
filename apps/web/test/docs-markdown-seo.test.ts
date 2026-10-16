import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  page: null as null | { url: string; canonical: string },
  prompt: "# Synthetic agent prompt\n",
  markdown: "# Synthetic API docs\n\nPOST /contacts/batch\n",
  getPage: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: async () => h.prompt }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("fixture:404");
  },
}));
vi.mock("../../docs/src/lib/get-llm-text", () => ({ getLLMText: async () => h.markdown }));
vi.mock("../../docs/src/lib/i18n", () => ({
  i18n: { defaultLanguage: "en" },
  isLocale: (value: string) => value === "en" || value === "pt-BR",
}));
vi.mock("../../docs/src/lib/site", () => ({
  pageAlternates: (page: { canonical: string }) => ({ canonical: page.canonical }),
}));
vi.mock("../../docs/src/lib/source", () => ({ source: { getPage: h.getPage } }));

// Docs has its own @/ tsconfig namespace. Load the actual handler at runtime
// so web's typecheck does not reinterpret the docs dependency tree as web code.
const routeModule = new URL("../../docs/src/app/llms.mdx/[[...slug]]/route.ts", import.meta.url)
  .href;
const {
  GET,
}: {
  GET: (request: Request, context: { params: Promise<{ slug?: string[] }> }) => Promise<Response>;
} = await import(routeModule);

describe("Markdown docs remain readable without competing with their HTML canonical", () => {
  beforeEach(() => {
    h.getPage.mockReset();
    h.getPage.mockImplementation(() => h.page);
    h.page = null;
  });

  it.each([
    [
      "/api-reference/endpoints/contacts/batch/post",
      "/api-reference/endpoints/contacts/batch/post",
    ],
    ["/pt-BR/quickstart", "/pt-BR/quickstart"],
    ["/pt-BR/api-reference/endpoints/contacts/get", "/api-reference/endpoints/contacts/get"],
  ])(
    "serves %s as markdown with noindex/follow and the HTML page's canonical",
    async (path, canonical) => {
      h.page = { url: path, canonical: `https://docs.mepmail.dev${canonical}` };
      const response = await GET(new Request(`https://docs.mepmail.dev${path}.md`), {
        params: Promise.resolve({ slug: path.slice(1).split("/") }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("link")).toBe(
        `<https://docs.mepmail.dev${canonical}>; rel="canonical"`,
      );
      expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
      expect(await response.text()).toBe(h.markdown);
    },
  );

  it("keeps the standalone agent prompt available without inventing an HTML canonical", async () => {
    const response = await GET(
      new Request("https://docs.mepmail.dev/prompts/migrate-from-resend.md"),
      {
        params: Promise.resolve({ slug: ["prompts", "migrate-from-resend"] }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, follow");
    expect(response.headers.get("link")).toBeNull();
    expect(await response.text()).toBe(h.prompt);
  });

  it("preserves unknown-document 404 and resolves a Portuguese URL in its locale", async () => {
    await expect(
      GET(new Request("https://docs.mepmail.dev/pt-BR/unknown.md"), {
        params: Promise.resolve({ slug: ["pt-BR", "unknown"] }),
      }),
    ).rejects.toThrow("fixture:404");
    expect(h.getPage).toHaveBeenCalledWith(["unknown"], "pt-BR");
  });
});
