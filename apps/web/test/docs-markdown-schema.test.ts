import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ spec: {} as Record<string, unknown> }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      args[0] === "./public/openapi.json" ? JSON.stringify(h.spec) : fs.readFileSync(...args),
  };
});

const docs = new URL("../../docs/", import.meta.url);
const actualSpec = JSON.parse(readFileSync(new URL("public/openapi.json", docs), "utf8"));
const helper = new URL("../../docs/src/lib/get-llm-text.ts", import.meta.url).href;

type Page = {
  path: string;
  url: string;
  data: {
    title: string;
    description?: string;
    _openapi?: { method: string };
    getText: (kind: string) => Promise<string>;
  };
};

function generatedPage(file: string, locale = "en") {
  const raw = readFileSync(new URL(`content/docs/${file}`, docs), "utf8");
  // The generated component's operation identifier is authoritative, not its
  // human-readable title or an inferred placeholder spelling.
  const operations = JSON.parse(raw.match(/operations={(\[[^\n]+\])}/)?.[1] ?? "[]");
  expect(operations).toHaveLength(1);
  const op = operations[0] as { path: string; method: string };
  expect(raw).toContain(`  method: ${op.method.toUpperCase()}`);
  const slug = file.replace(/\.mdx$/, "");
  const page: Page = {
    path: file,
    url: `${locale === "en" ? "" : `/${locale}`}/${slug}`,
    data: {
      title: raw.match(/^title: (.+)$/m)?.[1] ?? "Readable operation title",
      _openapi: { method: op.method.toUpperCase() },
      getText: async () => {
        throw new Error("Generated API pages must resolve their operation schema");
      },
    },
  };
  return { page, op };
}

async function markdown(page: Page) {
  const { getLLMText }: { getLLMText: (value: Page) => Promise<string> } = await import(helper);
  return getLLMText(page);
}

function schema(markdown: string) {
  const json = markdown.match(/```json\n([\s\S]+?)\n```/)?.[1];
  expect(json).toBeTruthy();
  return JSON.parse(json ?? "null");
}

beforeEach(() => {
  h.spec = structuredClone(actualSpec);
  vi.resetModules();
});

describe("generated API Markdown uses the operation identity instead of display titles", () => {
  for (const file of [
    "api-reference/endpoints/contacts/get.mdx",
    "api-reference/endpoints/contacts/id/preferences-link/post.mdx",
    "api-reference/endpoints/contacts/batch/post.mdx",
  ]) {
    for (const locale of ["en", "pt-BR"]) {
      it(`${locale}: includes the real ${file} operation and its schemas`, async () => {
        const { page, op } = generatedPage(file, locale);
        expect(page.data.title.startsWith("/")).toBe(false);
        const text = await markdown(page);
        expect(text).toContain(`# ${op.method.toUpperCase()} ${op.path} (${page.url})`);
        const result = schema(text);
        const expected = actualSpec.paths[op.path][op.method];
        expect(result.operationId).toBe(expected.operationId);
        expect(result.description).toBe(expected.description);
        expect(Object.keys(result.responses)).toEqual(Object.keys(expected.responses));
        expect(result.parameters).toEqual(expected.parameters);
        if (op.path === "/contacts/batch") {
          const request = result.requestBody.content["application/json"].schema;
          expect(request).toEqual(actualSpec.components.schemas.BatchContactsRequest);
          expect(request).not.toHaveProperty("$ref");
        }
      });
    }
  }

  it("resolves every existing generated operation without regenerating files or accessing services", async () => {
    const root = new URL("content/docs/api-reference/endpoints/", docs);
    // Dirent parentPath is an OS path, normalized for Windows and Linux.
    const directory = fileURLToPath(root);
    const entries = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (file) => file.isFile() && file.name.endsWith(".mdx"),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const file = `api-reference/endpoints/${relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`;
      const { page, op } = generatedPage(file);
      page.data.title = "A renamed display title";
      const text = await markdown(page);
      expect(schema(text).operationId).toBe(actualSpec.paths[op.path][op.method].operationId);
    }
  });

  it("refuses a missing, mismatched or ambiguous operation rather than silently omitting its schema", async () => {
    const { page } = generatedPage("api-reference/endpoints/contacts/get.mdx");
    page.path = "api-reference/endpoints/not-a-real-operation/get.mdx";
    await expect(markdown(page)).rejects.toThrow("Cannot uniquely resolve API operation");
    page.path = "api-reference/endpoints/contacts/get.mdx";
    page.data._openapi = { method: "DELETE" };
    await expect(markdown(page)).rejects.toThrow("Cannot uniquely resolve API operation");
    delete page.data._openapi;
    await expect(markdown(page)).rejects.toThrow("Missing API method");
    page.data._openapi = { method: "GET" };
    (h.spec.paths as Record<string, unknown>)["/CONTACTS"] = actualSpec.paths["/contacts"];
    vi.resetModules();
    await expect(markdown(page)).rejects.toThrow("Cannot uniquely resolve API operation");
  });

  it("keeps ordinary documentation content intact", async () => {
    const page: Page = {
      path: "concepts/segments.mdx",
      url: "/concepts/segments",
      data: {
        title: "Segments",
        description: "Saved filters over contacts.",
        getText: async () => "\n\n## Synthetic body\nOriginal Markdown.\n",
      },
    };
    expect(await markdown(page)).toBe(
      "# Segments (/concepts/segments)\n\nSaved filters over contacts.\n\n## Synthetic body\nOriginal Markdown.\n",
    );
  });
});
