import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps } from "../../api/src/app.js";

const h = vi.hoisted(() => ({
  specPath: "",
  unavailable: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const path = await import("node:path");
  const url = await import("node:url");
  function requireAvailable(file: unknown) {
    const name = file instanceof URL ? url.fileURLToPath(file) : file;
    if (
      typeof name === "string" &&
      h.unavailable.some(
        (item) => path.resolve(name) === item || path.resolve(name).startsWith(item + path.sep),
      )
    ) {
      throw Object.assign(
        new Error("ENOENT: checkout-generated artifacts deliberately unavailable"),
        {
          code: "ENOENT",
        },
      );
    }
  }
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === "./public/openapi.json") return fs.readFileSync(h.specPath, args[1]);
      requireAvailable(args[0]);
      return fs.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      requireAvailable(args[0]);
      return fs.readdirSync(...args);
    },
  };
});

const docs = new URL("../../docs/", import.meta.url);
const checkoutSpec = new URL("public/openapi.json", docs);
const checkoutEndpoints = new URL("content/docs/api-reference/endpoints/", docs);
h.unavailable = [checkoutSpec, checkoutEndpoints].map((url) => resolve(fileURLToPath(url)));
const temporary = mkdtempSync(join(tmpdir(), "mepmail-docs-schema-"));
const endpoints = join(temporary, "content", "docs", "api-reference", "endpoints");
h.specPath = join(temporary, "runtime-openapi.json");
const docsRequire = createRequire(new URL("package.json", docs));
const helper = new URL("../../docs/src/lib/get-llm-text.ts", import.meta.url).href;

type ApiDocument = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        description?: string;
        parameters?: unknown;
        responses: Record<string, unknown>;
      }
    >
  >;
  components: { schemas: Record<string, unknown> };
};
let actualSpec: ApiDocument;

function apiOperation(path: string, method: string) {
  const operation = actualSpec.paths[path]?.[method];
  if (!operation) throw new Error(`API builder did not produce ${method.toUpperCase()} ${path}`);
  return operation;
}

afterAll(() => {
  // Only the directory this suite created; never the shared docs outputs.
  expect(dirname(resolve(temporary))).toBe(resolve(tmpdir()));
  expect(basename(temporary)).toMatch(/^mepmail-docs-schema-/);
  expect(realpathSync(temporary)).toBe(resolve(temporary));
  rmSync(temporary, { recursive: true });
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Schema generation must not access the network");
  });
  const { createApi } = await import("../../api/src/app.js");
  const forbidden = () => {
    throw new Error("Schema extraction must not access a service");
  };
  const inert: ApiDeps = {
    db: null as unknown as ApiDeps["db"],
    keyring: null as unknown as ApiDeps["keyring"],
    isCloud: true,
    enqueueEmailSend: forbidden,
    ses: { regions: ["us-east-1"], clientForRegion: forbidden },
  };
  // Same app builder as the docs prebuild; Hono handles this in memory.
  const response = await createApi(inert).request("/openapi.json");
  expect(response.status).toBe(200);
  actualSpec = (await response.json()) as ApiDocument;
  const input = join(temporary, "original-openapi.json");
  writeFileSync(input, JSON.stringify(actualSpec));
  const {
    createOpenAPI,
  }: {
    createOpenAPI: (options: { input: string[] }) => unknown;
  } = await import(pathToFileURL(docsRequire.resolve("fumadocs-openapi/server")).href);
  const {
    generateFilesOnly,
  }: {
    generateFilesOnly: (options: {
      input: unknown;
      groupBy: "route";
      includeDescription: boolean;
    }) => Promise<{ path: string; content: string }[]>;
  } = await import(pathToFileURL(docsRequire.resolve("fumadocs-openapi")).href);
  const files = await generateFilesOnly({
    input: createOpenAPI({ input: [input] }),
    groupBy: "route",
    includeDescription: true,
  });
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const destination = resolve(endpoints, file.path);
    expect(relative(endpoints, destination)).not.toMatch(/^\.\.|^[A-Za-z]:|^[/\\]/);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
});

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
  const raw = readFileSync(join(temporary, "content", "docs", file), "utf8");
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
  writeFileSync(h.specPath, JSON.stringify(actualSpec));
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
        const expected = apiOperation(op.path, op.method);
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

  it("resolves every freshly generated operation while checkout-generated artifacts are unavailable", async () => {
    expect(() => readFileSync(checkoutSpec, "utf8")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(() => readdirSync(checkoutEndpoints)).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    const root = endpoints;
    // Dirent parentPath is an OS path, normalized for Windows and Linux.
    const directory = root;
    const entries = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (file) => file.isFile() && file.name.endsWith(".mdx"),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const file = `api-reference/endpoints/${relative(directory, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`;
      const { page, op } = generatedPage(file);
      page.data.title = "A renamed display title";
      const text = await markdown(page);
      expect(schema(text).operationId).toBe(apiOperation(op.path, op.method).operationId);
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
    const ambiguous = structuredClone(actualSpec);
    ambiguous.paths["/CONTACTS"] = { get: apiOperation("/contacts", "get") };
    writeFileSync(h.specPath, JSON.stringify(ambiguous));
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
