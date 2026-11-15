import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  items: new Map<
    string,
    {
      id: string;
      mailboxId: string;
      revision: number;
      kind: string;
      raw: Buffer;
      trashedAt: null;
      deliveryFolder: string;
    }
  >(),
  box: {
    id: "22222222-2222-4222-8222-222222222222",
    address: "person@example.invalid",
    canRead: true,
    canDraft: true,
    status: "planned",
    origin: "native",
    signatureProfile: null as null | {
      name: string;
      title: string;
      company: string;
      phone: string;
      website: string;
      logoUrl: string;
      logoWidth: number;
      logoHeight: number;
    },
    signatureText: "Synthetic Signature",
  },
  save: vi.fn(),
  registry: vi.fn(),
  access: vi.fn(),
  item: vi.fn(),
  itemsRead: vi.fn(),
  afterSave: vi.fn(),
  policy: true,
}));
vi.mock("@millionsend/config", () => ({
  env: { SENDING_PROVIDER_POLICY_JSON: "synthetic", MASTER_ENCRYPTION_KEY: "" },
  unsubscribeBaseUrl: () => "https://example.invalid",
}));
vi.mock("@millionsend/core", () => ({
  MailboxContentError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  appendMailboxActivity: vi.fn(),
  MAILBOX_RICH_FORMAT_HEADER: "X-MepMail-Format",
  listMailboxRegistry: h.registry,
  withMailboxItem: h.item,
  withMailboxItems: h.itemsRead,
  withMailboxContentAccess: h.access,
  saveMailboxDraft: h.save,
}));
// Explicit synthetic policy capability: no real database, key or network access.
vi.mock("../../../packages/core/src/mailbox-optout.js", () => ({
  mailboxDraftNeedsAzureOptout: () => h.policy,
  prepareMailboxOptout: async () => ({
    url: "https://example.invalid/optout/synthetic",
    text: "\n\nSynthetic mandatory optout",
    html: "<p>Synthetic mandatory optout</p>",
    headers: { "List-Unsubscribe": "<https://example.invalid/optout/synthetic>" },
  }),
}));
vi.mock("../src/server/keyring", () => ({ getKeyring: () => ({ synthetic: true }) }));
vi.mock("../src/server/procedure-timings", () => ({
  timedStage: async (_name: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/storage", () => ({
  publicStoragePrefix: () => "https://example.invalid/",
  publicStorageOrigin: () => "https://example.invalid",
}));
vi.mock("../src/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: () => null }));
vi.mock("../src/server/mailbox-sender-picture", () => ({ senderPictureToken: () => null }));
vi.mock("../src/server/mailbox-html", () => ({ projectMailboxHtml: () => ({}) }));
vi.mock("../src/server/mailbox-agent", () => ({
  MAILBOX_AGENT_HEADERS: { "Cache-Control": "private, no-store" },
  mailboxAgentRequest: async (
    _request: Request,
    scope: string,
    run: (ctx: unknown) => Promise<unknown>,
  ) => {
    expect(scope).toBe("draft");
    return Response.json(await run({ db, actor, mailboxId }));
  },
}));
const { saveMailboxContentDraft, verifyMailboxDraftComposition } = await import(
  "../src/server/mailbox-content"
);
const { POST } = await import("../src/app/api/mailbox-agent/drafts/route");
const { correioToolDefinitions } = await import("../../../packages/mcp/src/correio-tools");
const mailboxId = h.box.id;
const sourceId = "33333333-3333-4333-8333-333333333333";
const draftId = "44444444-4444-4444-8444-444444444444";
const actor = {
  teamId: "11111111-1111-4111-8111-111111111111",
  userId: "synthetic-owner",
  agentAccess: true as const,
};
const query = { from: () => query, where: () => query, limit: async () => [] };
const db = { select: () => query } as unknown as Db;
const input = () => ({
  mailboxId,
  expectedRevision: 0,
  sourceItemId: sourceId,
  mode: "reply" as const,
  to: ["recipient@example.invalid"],
  subject: "Re: Synthetic é",
  text: "Olá e\u0301\r\nBody  ",
  retainedAttachments: [] as number[],
  uploads: [] as { filename: string; base64: string }[],
});
const parse = (raw: Buffer) => simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
beforeEach(() => {
  vi.clearAllMocks();
  h.items.clear();
  h.policy = true;
  h.box.canRead = true;
  h.box.canDraft = true;
  h.box.signatureText = "Synthetic Signature";
  h.box.signatureProfile = {
    name: "Synthetic Name",
    title: "Advisor",
    company: "Synthetic Company",
    phone: "+55 (11) 1234-5678",
    website: "http://example.invalid/account?q=1",
    logoUrl: "https://example.invalid/mutable-logo.png?v=1",
    logoWidth: 100,
    logoHeight: 50,
  };
  h.items.set(sourceId, {
    id: sourceId,
    mailboxId,
    revision: 1,
    kind: "inbox",
    raw: Buffer.from(
      "From: recipient@example.invalid\r\nTo: person@example.invalid\r\nSubject: Synthetic\r\nMessage-ID: <source@example.invalid>\r\n\r\nOriginal synthetic source",
    ),
    trashedAt: null,
    deliveryFolder: "inbox",
  });
  h.registry.mockImplementation(async () => ({ mailboxes: [{ ...h.box }] }));
  h.item.mockImplementation(async (_db, _keys, _actor, input, run) => {
    const row = h.items.get(input.id);
    if (!row || row.mailboxId !== input.mailboxId) throw new Error("not_found");
    return run(row);
  });
  h.itemsRead.mockImplementation(async (_db, _keys, _actor, input, run) =>
    run(
      input.ids
        .map((id: string) => h.items.get(id))
        .filter((row: { mailboxId: string } | undefined) => row?.mailboxId === input.mailboxId),
    ),
  );
  h.access.mockImplementation(async (_db, _actor, _boxes, run) => run(db));
  h.afterSave.mockImplementation(async () => {});
  h.save.mockImplementation(async (_db, _keys, _actor, input) => {
    const row = {
      id: input.id ?? draftId,
      mailboxId,
      revision: input.expectedRevision + 1,
      kind: "draft",
      raw: Buffer.from(input.raw),
      trashedAt: null,
      deliveryFolder: "inbox",
    };
    h.items.set(row.id, row);
    const { raw: _raw, ...summary } = row;
    await h.afterSave();
    return summary;
  });
});

const toolFor = (surface: "npm" | "hosted-correio" | "hosted-oauth" = "hosted-correio") => {
  const calls: unknown[] = [];
  const tools = correioToolDefinitions(
    surface,
    {
      call: async (method: string, path: string, payload: unknown) => {
        calls.push({ method, path, payload });
        const response = await POST(
          new Request("https://example.invalid/api/mailbox-agent/drafts", {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }),
        );
        const body = await response.json();
        return { content: [{ type: "text", text: JSON.stringify(body) }], isError: !response.ok };
      },
      result: (body: unknown, ok = true) => ({
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: !ok,
      }),
    } as never,
    z,
  );
  return { tool: tools.find((t) => t.name === "mailbox_save_draft")!, calls };
};
const mcpInput = () => ({
  to: input().to,
  text: input().text,
  subject: input().subject,
  expected_revision: 0,
  message_format: "plain_text",
});
describe("explicit Native text-only draft", () => {
  it("runs published schema -> HTTP route -> real composer -> single-part MIME with full signature links", async () => {
    const { tool, calls } = toolFor();
    const args = tool.inputSchema.parse(mcpInput());
    expect(args).toHaveProperty("message_format", "plain_text");
    expect(z.toJSONSchema(tool.inputSchema).properties?.message_format).toMatchObject({
      enum: ["plain_text"],
    });
    const result = await tool.handler(args as never);
    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/mailbox-agent/drafts",
        payload: expect.objectContaining({ messageFormat: "plain_text" }),
      }),
    ]);
    const raw = h.items.get(draftId)!.raw;
    const mime = await parse(raw);
    expect(mime.headers.get("content-type")).toMatchObject({ value: "text/plain" });
    expect(mime.html).toBe(false);
    expect(mime.attachments).toEqual([]);
    expect(raw.toString()).not.toMatch(
      /text\/html|multipart\/|<img|mutable-logo|X-MepMail-Format/i,
    );
    for (const word of [
      "Synthetic Name",
      "Advisor",
      "Synthetic Company",
      "+55 (11) 1234-5678",
      "http://example.invalid/account?q=1",
      "Synthetic Signature",
      "Synthetic mandatory optout",
    ])
      expect(mime.text).toContain(word);
    expect(mime.from?.value[0]?.address).toBe(h.box.address);
    expect(mime.to).toMatchObject({ value: [{ address: input().to[0] }] });
    expect(mime.headerLines.find((h) => h.key === "list-unsubscribe")?.line).toContain(
      "https://example.invalid/optout/synthetic",
    );
    expect(JSON.parse(result.content[0]?.text ?? "")).not.toHaveProperty("composition");
  });
});

const direct = (extra: Record<string, unknown> = {}) =>
  POST(
    new Request("https://example.invalid/api/mailbox-agent/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input(),
        mailboxId: undefined,
        messageFormat: "plain_text",
        ...extra,
      }),
    }),
  );
describe("text-only boundaries and legacy preservation", () => {
  it("preserves Cc/Bcc, effective Reply-To (= own From), thread and exact Inbox source bytes", async () => {
    const original = Buffer.from(h.items.get(sourceId)!.raw);
    const saved = await saveMailboxContentDraft(db, actor, {
      ...input(),
      messageFormat: "plain_text",
      cc: ["copy@example.invalid"],
      bcc: ["blind@example.invalid"],
    });
    const mime = await parse(h.items.get(saved.id)!.raw);
    expect(mime.from?.value[0]?.address).toBe(h.box.address);
    // Native's existing API has no authored Reply-To option: its effective reply address is From.
    expect(mime.replyTo?.value[0]?.address ?? mime.from?.value[0]?.address).toBe(h.box.address);
    expect(mime.cc).toMatchObject({ value: [{ address: "copy@example.invalid" }] });
    expect(mime.bcc).toMatchObject({ value: [{ address: "blind@example.invalid" }] });
    expect(mime.inReplyTo).toBe("<source@example.invalid>");
    expect(mime.references).toContain("<source@example.invalid>");
    expect(h.items.get(sourceId)!.raw).toEqual(original);
    expect(saved).not.toHaveProperty("composition");
    expect(mime.html).toBe(false);
  });
  it("keeps default logo HTML and v1 receipt unchanged when format is omitted", async () => {
    const saved = await saveMailboxContentDraft(db, actor, input());
    const raw = h.items.get(saved.id)!.raw;
    const mime = await parse(raw);
    expect(mime.html).toContain(h.box.signatureProfile!.logoUrl.replace(/&/g, "&amp;"));
    expect(mime.html).toContain("border-left:2px");
    expect(mime.text).toContain("Synthetic Signature");
    expect(saved).toHaveProperty("composition");
    await expect(
      verifyMailboxDraftComposition(db, actor, { ...input(), id: saved.id, expectedRevision: 1 }),
    ).resolves.toBeDefined();
    // The real requalification succeeds; its receipt shape is covered by mailbox-composition.test.ts.
  });
  it("does not attest the explicit format as an old composition receipt", async () => {
    await expect(
      verifyMailboxDraftComposition(db, actor, {
        ...input(),
        id: draftId,
        expectedRevision: 1,
        messageFormat: "plain_text",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["rich", "html", "PLAIN_TEXT", "", null, 1])(
    "rejects invalid API enum %s before persistence",
    async (messageFormat) => {
      expect((await direct({ messageFormat })).status).toBe(400);
      expect(h.save).not.toHaveBeenCalled();
    },
  );
  it.each([
    { id: draftId, sourceItemId: draftId, expectedRevision: 1 },
    { expectedRevision: 1 },
    { retainedAttachments: [0] },
    { uploads: [{ filename: "file.txt", base64: "dGVzdA==" }] },
    { html: "<p>Authored rich HTML</p>" },
    { html: "" },
  ])("rejects incompatible HTTP inputs without saving: %j", async (extra) => {
    const response = await direct(extra);
    expect(response.status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each([
    { id: draftId, sourceItemId: draftId, expectedRevision: 1 },
    { expectedRevision: 1 },
    { retainedAttachments: [0] },
    { uploads: [{ filename: "file.txt", base64: "dGVzdA==" }] },
    { html: "<p>Authored rich HTML</p>" },
    { html: "" },
    { messageFormat: "html" },
  ])("defends the real composer independently of API validation: %j", async (extra) => {
    await expect(
      saveMailboxContentDraft(db, actor, {
        ...input(),
        messageFormat: "plain_text",
        ...extra,
      } as never),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("refuses a draft as source without altering its legacy MIME", async () => {
    const original = Buffer.from(
      'From: person@example.invalid\r\nTo: recipient@example.invalid\r\nContent-Type: text/html\r\n\r\n<p>Legacy content<img src="https://example.invalid/logo.png"></p>',
    );
    h.items.set(draftId, { ...h.items.get(sourceId)!, id: draftId, kind: "draft", raw: original });
    await expect(
      saveMailboxContentDraft(db, actor, {
        ...input(),
        sourceItemId: draftId,
        messageFormat: "plain_text",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.items.get(draftId)!.raw).toEqual(original);
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["npm", "hosted-correio", "hosted-oauth"])(
    "publishes the same opt-in enum on %s and rejects incompatible MCP requests before I/O",
    async (surface) => {
      const { tool, calls } = toolFor(surface as never);
      expect(tool.inputSchema.safeParse({ ...mcpInput(), message_format: "html" }).success).toBe(
        false,
      );
      expect(tool.description).toContain("plain_text");
      expect(tool.description).toContain("logo");
      for (const extra of [
        { id: draftId },
        { expected_revision: 1 },
        { attachments: [{ filename: "f", content_base64: "dGVzdA==" }] },
        { keep_attachments: [0] },
      ]) {
        const result = await tool.handler(
          tool.inputSchema.parse({ ...mcpInput(), ...extra }) as never,
        );
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]?.text ?? "").hint).toMatch(/new draft|attachments/i);
      }
      expect(calls).toEqual([]);
      expect(h.save).not.toHaveBeenCalled();
    },
  );
  it("does not turn the format option into mailbox authority", async () => {
    h.box.canDraft = false;
    await expect(
      saveMailboxContentDraft(db, actor, { ...input(), messageFormat: "plain_text" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("includes the textual signature once and no optout when the existing policy does not require one", async () => {
    h.policy = false;
    const saved = await saveMailboxContentDraft(db, actor, {
      ...input(),
      sourceItemId: undefined,
      messageFormat: "plain_text",
    });
    const mime = await parse(h.items.get(saved.id)!.raw);
    expect(mime.text?.match(/Synthetic Signature/g)).toHaveLength(1);
    expect(mime.headerLines.some((h) => h.key === "list-unsubscribe")).toBe(false);
    expect(mime.html).toBe(false);
    expect(mime.attachments).toHaveLength(0);
  });
});

describe("MCP default and new forward compatibility", () => {
  it("keeps omitted format out of the HTTP payload and retains the formatted logo default", async () => {
    const { tool, calls } = toolFor();
    const { message_format: _format, ...args } = mcpInput();
    const result = await tool.handler(tool.inputSchema.parse(args) as never);
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { payload: unknown }).payload).not.toHaveProperty("messageFormat");
    expect((await parse(h.items.get(draftId)!.raw)).html).toContain("mutable-logo");
  });
  it("creates a new text-only forward without inherited threading or rewriting source MIME", async () => {
    const before = Buffer.from(h.items.get(sourceId)!.raw);
    const saved = await saveMailboxContentDraft(db, actor, {
      ...input(),
      mode: "forward",
      messageFormat: "plain_text",
    });
    const mime = await parse(h.items.get(saved.id)!.raw);
    expect(mime.html).toBe(false);
    expect(mime.attachments).toEqual([]);
    expect(mime.inReplyTo).toBeUndefined();
    expect(mime.references).toBeUndefined();
    expect(mime.text).toContain("http://example.invalid/account?q=1");
    expect(h.items.get(sourceId)!.raw).toEqual(before);
  });
});
