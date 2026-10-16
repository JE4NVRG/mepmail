import { readFileSync } from "node:fs";
import type { InferPageType } from "fumadocs-core/source";
import type { source } from "@/lib/source";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// cwd-relative like src/lib/openapi.ts: every docs command runs from apps/docs.
let spec:
  | {
      paths?: Record<string, Record<string, Json>>;
      components?: { schemas?: Record<string, Json> };
    }
  | undefined;
function openapiDocument() {
  spec ??= JSON.parse(readFileSync("./public/openapi.json", "utf8"));
  return spec as NonNullable<typeof spec>;
}

/** Inlines `$ref`s so an operation reads on its own; depth-capped against recursive schemas. */
function inlineRefs(node: Json, depth = 0): Json {
  if (depth > 8 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, depth + 1));
  const ref = node.$ref;
  if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
    const target =
      openapiDocument().components?.schemas?.[ref.slice("#/components/schemas/".length)];
    return target === undefined ? node : inlineRefs(target, depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, inlineRefs(v, depth + 1)]));
}

/** Mirrors Fumadocs' groupBy: "route" filename, independent of display titles. */
function operationPath(page: InferPageType<typeof source>, method: string): string {
  const file = page.path.replaceAll("\\", "/").replace(/\.pt-BR\.mdx$/, ".mdx");
  const matches = Object.keys(openapiDocument().paths ?? {}).filter((path) => {
    // fumadocs-openapi's routePathToFilePath strips braces, lowercases and
    // replaces dots. Resolve forward from real spec keys, never guess {id}.
    const route = path
      .toLowerCase()
      .replaceAll(".", "-")
      .split("/")
      .filter(Boolean)
      .map((part) => (part.startsWith("{") && part.endsWith("}") ? part.slice(1, -1) : part))
      .join("/");
    return (
      file === `api-reference/endpoints/${route}/${method}.mdx` &&
      openapiDocument().paths?.[path]?.[method] !== undefined
    );
  });
  if (matches.length !== 1) throw new Error(`Cannot uniquely resolve API operation for ${file}`);
  return matches[0] as string;
}

/**
 * Markdown rendition of a page for agents (*.md routes and /llms-full.txt).
 * API reference pages are generated MDX whose body is just a component call,
 * so they get their operation from the spec — method, path, parameters,
 * request and response schemas with every reference inlined — the shape an
 * agent needs to implement the call without a second fetch.
 */
export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const header = `# ${page.data.title} (${page.url})`;
  const description = page.data.description ? `\n\n${page.data.description}` : "";

  // includes(): the URL carries a locale prefix on non-default locales.
  if (page.url.includes("/api-reference/endpoints")) {
    const method = (
      page.data as { _openapi?: { method?: string } }
    )._openapi?.method?.toLowerCase();
    if (!method) throw new Error(`Missing API method for ${page.path}`);
    const path = operationPath(page, method);
    const operation = openapiDocument().paths?.[path]?.[method];
    const spec = `\n\n\`\`\`json\n${JSON.stringify(inlineRefs(operation ?? null), null, 2)}\n\`\`\``;
    return `# ${method.toUpperCase()} ${path} (${page.url})${description}

MepMail API operation. Base URL https://api.mepmail.dev (self-hosted: the instance's own API origin); authenticate with \`Authorization: Bearer ms_...\`. The wire format is Resend-compatible. Full OpenAPI 3.1 spec: /openapi.json.${spec}`;
  }

  const processed = await page.data.getText("processed");
  return `${header}${description}\n\n${processed.trimStart()}`;
}
