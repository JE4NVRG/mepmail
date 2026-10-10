import { describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/app.js";
import { OPERATION_META } from "../src/openapi-meta.js";

// Same inert deps as apps/docs/scripts/generate-openapi.ts: serving
// /openapi.json registers routes only and runs no handler.
const app = createApi({
  db: null as unknown as ApiDeps["db"],
  keyring: null as unknown as ApiDeps["keyring"],
  isCloud: false,
  enqueueEmailSend: async () => {},
  ses: {} as ApiDeps["ses"],
});

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  responses: Record<string, { headers?: Record<string, unknown> }>;
  requestBody?: { content: Record<string, { example?: unknown }> };
};

async function spec() {
  const res = await app.request("/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    paths: Record<string, Record<string, Operation>>;
    security: unknown;
    tags: { name: string }[];
    components: { securitySchemes: Record<string, { scheme?: string }> };
  };
}

describe("published OpenAPI document", () => {
  it("gives every operation an id, a summary, a description and a tag, and keeps the metadata exhaustive", async () => {
    const doc = await spec();
    const seen: string[] = [];
    const ids = new Set<string>();
    const summaries = new Set<string>();
    const tagNames = new Set(doc.tags.map((tag) => tag.name));
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        seen.push(key);
        expect(OPERATION_META[key], key).toBeDefined();
        expect(operation.operationId, key).toMatch(/^[a-z][A-Za-z]+$/);
        expect(ids.has(operation.operationId ?? ""), `duplicate id ${key}`).toBe(false);
        ids.add(operation.operationId ?? "");
        // The summary is the docs page title, so two pages never share one.
        expect(summaries.has(operation.summary ?? ""), `duplicate summary ${key}`).toBe(false);
        summaries.add(operation.summary ?? "");
        expect(operation.description?.trim().length, key).toBeGreaterThan(10);
        expect(operation.tags?.length, key).toBe(1);
        expect(tagNames.has(operation.tags?.[0] ?? ""), key).toBe(true);
      }
    }
    expect(seen.sort()).toEqual(Object.keys(OPERATION_META).sort());
  });

  it("documents the bearer key and the 401 and 429 answers on every operation", async () => {
    const doc = await spec();
    expect(doc.components.securitySchemes.apiKey?.scheme).toBe("bearer");
    expect(doc.security).toEqual([{ apiKey: [] }]);
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        expect(operation.responses["401"], key).toBeDefined();
        expect(operation.responses["429"]?.headers?.["Retry-After"], key).toBeDefined();
      }
    }
  });

  it("carries a request example for sending", async () => {
    const doc = await spec();
    const send = doc.paths["/emails"]?.post;
    expect(send?.operationId).toBe("sendEmail");
    expect(send?.requestBody?.content["application/json"]?.example).toMatchObject({
      subject: expect.any(String),
    });
  });
});
