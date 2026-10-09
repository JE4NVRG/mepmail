import { describe, expect, it } from "vitest";
import { testCorreioConnection } from "@/server/correio-connection-test";

const URL_ = "https://api.example/mcp/correio";
const TOKEN = `mmt_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.${"a".repeat(43)}`;

const sse = (message: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const json = (message: unknown, status = 200) =>
  new Response(JSON.stringify(message), {
    status,
    headers: { "content-type": "application/json" },
  });
const envelope = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ notice: "data", untrusted_data: data }) }],
});

function server(answers: Response[]) {
  const calls: { url: string; auth: string | null; method: string }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({
      url,
      auth: headers.get("authorization"),
      method: (JSON.parse(String(init.body)) as { method: string }).method,
    });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("testCorreioConnection", () => {
  it("initializes, lists the key's mailboxes and reports them", async () => {
    const { fetch, calls } = server([
      sse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
      sse({
        jsonrpc: "2.0",
        id: 2,
        result: envelope({
          credential: "team",
          mailboxes: [
            { address: "jean@x.invalid", scopes: ["read", "draft"], available: true },
            { address: "suporte@x.invalid", scopes: ["read"], available: false },
          ],
        }),
      }),
    ]);
    let clock = 1000;
    const result = await testCorreioConnection(URL_, TOKEN, { fetch, now: () => (clock += 120) });
    expect(result).toEqual({
      ok: true,
      latencyMs: 120,
      mailboxes: [
        { address: "jean@x.invalid", scopes: ["read", "draft"], available: true },
        { address: "suporte@x.invalid", scopes: ["read"], available: false },
      ],
    });
    expect(calls.map((c) => [c.url, c.method, c.auth])).toEqual([
      [URL_, "initialize", `Bearer ${TOKEN}`],
      [URL_, "tools/call", `Bearer ${TOKEN}`],
    ]);
  });

  it("says rejected for a refused key and never calls out for a malformed one", async () => {
    const refused = server([
      json({ jsonrpc: "2.0", id: 1, result: {} }),
      json({ jsonrpc: "2.0", id: 2, result: { ...envelope({ status: 403 }), isError: true } }),
    ]);
    expect(await testCorreioConnection(URL_, TOKEN, { fetch: refused.fetch })).toEqual({
      ok: false,
      reason: "rejected",
    });
    const unauthorized = server([json({ error: "unauthorized" }, 401)]);
    expect(await testCorreioConnection(URL_, TOKEN, { fetch: unauthorized.fetch })).toEqual({
      ok: false,
      reason: "rejected",
      status: 401,
    });
    const none = server([]);
    expect(
      await testCorreioConnection(URL_, "re_not-a-correio-key", { fetch: none.fetch }),
    ).toEqual({ ok: false, reason: "rejected" });
    expect(none.calls).toEqual([]);
  });

  it("separates an unreachable endpoint from an unexpected answer", async () => {
    const down = server([]);
    expect(await testCorreioConnection(URL_, TOKEN, { fetch: down.fetch })).toEqual({
      ok: false,
      reason: "unreachable",
    });
    const broken = server([new Response("<html>bad gateway</html>", { status: 502 })]);
    expect(await testCorreioConnection(URL_, TOKEN, { fetch: broken.fetch })).toEqual({
      ok: false,
      reason: "unexpected",
      status: 502,
    });
  });
});
