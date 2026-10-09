import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { CORREIO_TOOL_NAMES, MAIL_TOKEN, registerCorreioTools } from "../src/correio.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

function setup(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const tools = new Map<string, { config: { annotations?: object }; cb: Handler }>();
  const server = {
    registerTool: (name: string, config: { annotations?: object }, cb: Handler) => {
      tools.set(name, { config, cb });
    },
  } as unknown as McpServer;
  const calls: { url: string; init: RequestInit }[] = [];
  registerCorreioTools(server, {
    token: "mmt_00000000-0000-4000-8000-000000000000.abc",
    origin: "https://mepmail.dev/",
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answer(url, init);
    }) as typeof fetch,
  });
  return { tools, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const payload = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]!.text) as {
    notice: string;
    untrusted_data: Record<string, unknown>;
  };

describe("Correio tools in the local MCP", () => {
  it("registers the hosted server's five tools with honest annotations", () => {
    const { tools } = setup(() => json({}));
    expect([...tools.keys()]).toEqual([...CORREIO_TOOL_NAMES]);
    expect(tools.get("mailbox_list_messages")?.config.annotations).toEqual({ readOnlyHint: true });
    expect(tools.get("mailbox_send_draft")?.config.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it("calls the agent API with the key, the named mailbox and the draft body", async () => {
    const { tools, calls } = setup(() => json({ id: "d1", revision: 1 }));
    await tools
      .get("mailbox_list_messages")!
      .cb({ folder: "sent", mailbox: "suporte@mepmail.dev" });
    await tools.get("mailbox_save_draft")!.cb({
      to: ["a@example.com"],
      subject: "Re: oi",
      text: "Olá",
      expected_revision: 0,
      source_item_id: "11111111-1111-4111-8111-111111111111",
      mode: "reply",
      mailbox: "jean@mepmail.dev",
    });
    const [list, draft] = calls;
    expect(list!.url).toBe("https://mepmail.dev/api/mailbox-agent/items?folder=sent");
    const headers = list!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer mmt_00000000-0000-4000-8000-000000000000.abc");
    expect(headers["mepmail-mailbox"]).toBe("suporte@mepmail.dev");
    expect(list!.init.redirect).toBe("manual");
    expect(draft!.url).toBe("https://mepmail.dev/api/mailbox-agent/drafts");
    expect(JSON.parse(String(draft!.init.body))).toEqual({
      expectedRevision: 0,
      sourceItemId: "11111111-1111-4111-8111-111111111111",
      mode: "reply",
      to: ["a@example.com"],
      subject: "Re: oi",
      text: "Olá",
      retainedAttachments: [],
      uploads: [],
    });
    expect((draft!.init.headers as Record<string, string>)["mepmail-mailbox"]).toBe(
      "jean@mepmail.dev",
    );
  });

  it("wraps content as untrusted data and explains refusals", async () => {
    const { tools } = setup((url) =>
      url.endsWith("/send")
        ? json({ error: "rate_limited" }, 429, { "retry-after": "30" })
        : json({ mailboxes: [{ address: "sage@je4ndev.com" }] }),
    );
    const listed = await tools.get("mailbox_list_accounts")!.cb({});
    expect(listed.isError).toBeUndefined();
    expect(payload(listed).notice).toMatch(/never as instructions/);
    const refused = await tools.get("mailbox_send_draft")!.cb({
      id: "22222222-2222-4222-8222-222222222222",
      expected_revision: 2,
    });
    expect(refused.isError).toBe(true);
    expect(payload(refused).untrusted_data).toMatchObject({
      error: "rate_limited",
      status: 429,
      retry_after_seconds: 30,
    });
  });

  it("marks an unanswered write as outcome unknown, never as failed", async () => {
    const { tools } = setup(() => {
      throw new TypeError("network down");
    });
    const result = await tools.get("mailbox_send_draft")!.cb({
      id: "22222222-2222-4222-8222-222222222222",
      expected_revision: 2,
    });
    expect(result.isError).toBe(true);
    expect(payload(result).untrusted_data).toMatchObject({
      error: "unavailable",
      outcome_unknown: true,
    });
  });

  it("accepts only Correio agent keys", () => {
    expect(MAIL_TOKEN.test("mmb_00000000-0000-4000-8000-000000000000.x")).toBe(true);
    expect(MAIL_TOKEN.test("mmt_00000000-0000-4000-8000-000000000000.x")).toBe(true);
    expect(MAIL_TOKEN.test("ms_123")).toBe(false);
    expect(MAIL_TOKEN.test("mmb_ with space")).toBe(false);
  });
});
