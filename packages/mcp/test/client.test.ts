import { describe, expect, it, vi } from "vitest";
import { createClient, MepMailApiError } from "../src/client.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createClient", () => {
  it("strips trailing slashes, sends the bearer key, JSON body and parses the reply", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ id: "e_1" });
    });
    const client = createClient({
      apiKey: "ms_test",
      baseUrl: "https://api.example.com//",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const data = await client.request("POST", "/emails", { subject: "Hi" });

    expect(data).toEqual({ id: "e_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.com/emails");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ms_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ subject: "Hi" }));
  });

  it("omits the content-type on bodyless requests", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse({ object: "list", data: [] });
    });
    const client = createClient({
      apiKey: "ms_test",
      baseUrl: "https://api.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.request("GET", "/domains");

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBeUndefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("maps API errors to MepMailApiError carrying status, name and parsed payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ statusCode: 422, name: "validation_error", message: "bad payload" }, 422),
    );
    const client = createClient({
      apiKey: "ms_test",
      baseUrl: "https://api.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await client.request("POST", "/emails", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MepMailApiError);
    const apiError = error as MepMailApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.apiName).toBe("validation_error");
    expect(apiError.payload).toMatchObject({ name: "validation_error", message: "bad payload" });
  });

  it("falls back to http_<status> when the error body has no name", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 }));
    const client = createClient({
      apiKey: "ms_test",
      baseUrl: "https://api.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = (await client
      .request("GET", "/usage")
      .catch((e: unknown) => e)) as MepMailApiError;

    expect(error.apiName).toBe("http_502");
    expect(error.payload).toBe("boom");
  });
});
