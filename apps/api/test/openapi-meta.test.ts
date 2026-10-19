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
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>;
      content?: Record<string, { example?: unknown; schema?: unknown }>;
    }
  >;
  requestBody?: { content: Record<string, { example?: unknown; schema?: unknown }> };
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type: string; minLength?: number };
  }[];
};

async function spec() {
  const res = await app.request("/openapi.json");
  expect(res.status).toBe(200);
  return (await res.json()) as {
    paths: Record<string, Record<string, Operation>>;
    security: unknown;
    tags: { name: string }[];
    components: {
      securitySchemes: Record<string, { scheme?: string }>;
      schemas: Record<string, Schema>;
    };
  };
}

type Schema = Record<string, unknown>;

/** A small JSON Schema check (the keywords this document uses), enough to prove an example fits. */
function fits(
  value: unknown,
  schema: unknown,
  schemas: Record<string, Schema>,
  at: string,
): string[] {
  let node = schema as Schema | undefined;
  while (node && typeof node.$ref === "string") node = schemas[node.$ref.split("/").at(-1) ?? ""];
  if (!node || typeof node !== "object") return [];
  const problems: string[] = [];
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = node[key] as unknown[] | undefined;
    if (Array.isArray(options) && !options.some((o) => fits(value, o, schemas, at).length === 0))
      problems.push(`${at}: matches no ${key} option`);
  }
  for (const part of (node.allOf as unknown[] | undefined) ?? [])
    problems.push(...fits(value, part, schemas, at));
  if (Array.isArray(node.enum) && !node.enum.includes(value)) problems.push(`${at}: not in enum`);
  const declared = node.type;
  const types = Array.isArray(declared) ? declared : declared ? [declared] : [];
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : Number.isInteger(value)
          ? "integer"
          : typeof value;
  if (
    types.length > 0 &&
    !types.includes(kind) &&
    !(kind === "integer" && types.includes("number"))
  )
    problems.push(`${at}: ${kind} is not ${types.join("|")}`);
  if (kind === "string") {
    const text = value as string;
    if (typeof node.minLength === "number" && text.length < node.minLength)
      problems.push(`${at}: too short`);
    if (typeof node.maxLength === "number" && text.length > node.maxLength)
      problems.push(`${at}: too long`);
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(text))
      problems.push(`${at}: pattern`);
    if (node.format === "uuid" && !/^[0-9a-f-]{36}$/i.test(text))
      problems.push(`${at}: not a uuid`);
    if (node.format === "email" && !/^[^@\s]+@[^@\s]+$/.test(text))
      problems.push(`${at}: not an email`);
  }
  if (kind === "integer" || kind === "number") {
    const number = value as number;
    if (typeof node.minimum === "number" && number < node.minimum)
      problems.push(`${at}: below minimum`);
    if (typeof node.maximum === "number" && number > node.maximum)
      problems.push(`${at}: above maximum`);
  }
  if (kind === "array") {
    const items = value as unknown[];
    if (typeof node.minItems === "number" && items.length < node.minItems)
      problems.push(`${at}: too few items`);
    if (typeof node.maxItems === "number" && items.length > node.maxItems)
      problems.push(`${at}: too many items`);
    for (const [index, item] of items.entries())
      problems.push(...fits(item, node?.items, schemas, `${at}[${index}]`));
  }
  if (kind === "object") {
    const object = value as Record<string, unknown>;
    const properties = (node.properties as Record<string, unknown> | undefined) ?? {};
    for (const required of (node.required as string[] | undefined) ?? [])
      if (!(required in object)) problems.push(`${at}: missing ${required}`);
    for (const [key, child] of Object.entries(object)) {
      if (key in properties)
        problems.push(...fits(child, properties[key], schemas, `${at}.${key}`));
      else if (node.additionalProperties === false) problems.push(`${at}: unexpected ${key}`);
    }
  }
  return problems;
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

  it("gives every request body and every JSON 200 an example that fits its schema", async () => {
    const doc = await spec();
    const problems: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const key = `${method.toUpperCase()} ${path}`;
        const body = operation.requestBody?.content["application/json"];
        if (body) {
          if (body.example === undefined) problems.push(`${key}: no request example`);
          else
            problems.push(
              ...fits(body.example, body.schema, doc.components.schemas, `${key} request`),
            );
          checked++;
        }
        const ok = operation.responses["200"]?.content?.["application/json"];
        if (ok?.schema !== undefined) {
          if (ok.example === undefined) problems.push(`${key}: no response example`);
          else problems.push(...fits(ok.example, ok.schema, doc.components.schemas, `${key} 200`));
          checked++;
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps the send examples on one sender and one recipient", async () => {
    const doc = await spec();
    const send = doc.paths["/emails"]!.post!.requestBody!.content["application/json"]!;
    expect(send.example).toMatchObject({
      from: "Acme <hello@yourdomain.com>",
      to: ["customer@example.com"],
    });
    expect(JSON.stringify(doc)).not.toContain("resend.dev");
  });

  it("carries a request example for sending", async () => {
    const doc = await spec();
    const send = doc.paths["/emails"]?.post;
    expect(send?.operationId).toBe("sendEmail");
    expect(send?.requestBody?.content["application/json"]?.example).toMatchObject({
      subject: expect.any(String),
    });
  });

  it("declares the optional HTTP idempotency header on single and batch sends only", async () => {
    const doc = await spec();
    const sends: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const headers = operation.parameters?.filter((p) => p.name === "Idempotency-Key") ?? [];
        if (headers.length === 0) continue;
        sends.push(`${method.toUpperCase()} ${path}`);
        expect(headers).toHaveLength(1);
        expect(headers[0]).toMatchObject({
          in: "header",
          required: false,
          schema: { type: "string", minLength: 1 },
        });
        expect(headers[0]?.description).toContain("team");
        expect(headers[0]?.description).toContain("24 hours");
        expect(headers[0]?.description).toContain("10 minutes");
        expect(headers[0]?.description).toContain("invalid_idempotent_request");
        expect(headers[0]?.description).toContain("concurrent_idempotent_requests");
      }
    }
    expect(sends.sort()).toEqual(["POST /emails", "POST /emails/batch"]);
  });
});
