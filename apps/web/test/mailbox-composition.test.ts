import { createHash } from "node:crypto";
import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailboxCompositionSemantics,
  mailboxPayloadSha256,
} from "../src/server/mailbox-composition";

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
    signatureProfile: null,
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
const { getMailboxContent, saveMailboxContentDraft, verifyMailboxDraftComposition } = await import(
  "../src/server/mailbox-content"
);
const { POST } = await import("../src/app/api/mailbox-agent/drafts/composition/route");
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
const legacy = () => ({ ...input(), id: draftId, expectedRevision: 1 });
const parse = (raw: Buffer) => simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
beforeEach(() => {
  vi.clearAllMocks();
  h.items.clear();
  h.policy = true;
  h.box.canRead = true;
  h.box.canDraft = true;
  h.box.signatureText = "Synthetic Signature";
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
describe("synthetic provider composition v1", () => {
  it("reads raw digest bound to exact authorized draft ID/mailbox/revision", async () => {
    const saved = await saveMailboxContentDraft(db, actor, input());
    const item = await getMailboxContent(db, actor, { mailboxId, id: saved.id });
    expect(item.id).toBe(saved.id);
    expect(item.mailboxId).toBe(mailboxId);
    expect(item.revision).toBe(saved.revision);
    expect(item.contentSha256).toBe(
      createHash("sha256").update(h.items.get(saved.id)!.raw).digest("hex"),
    );
    h.access.mockRejectedValueOnce(new Error("revoked read grant"));
    await expect(getMailboxContent(db, actor, { mailboxId, id: saved.id })).rejects.toThrow(
      "revoked",
    );
  });
  it("rejects source authority revoked across composition awaits without saving", async () => {
    const original = h.item.getMockImplementation()!;
    h.item.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      h.box.canDraft = false;
      return result;
    });
    // Verification has no creation path even when authority disappears after source read.
    await expect(verifyMailboxDraftComposition(db, actor, legacy())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("preserves current actor/team authority on the final guarded read", async () => {
    await saveMailboxContentDraft(db, actor, input());
    h.save.mockClear();
    h.access.mockImplementationOnce(async (_db, currentActor) => {
      expect(currentActor.teamId).toBe("other-synthetic-tenant");
      throw new Error("wrong tenant");
    });
    await expect(
      verifyMailboxDraftComposition(db, { ...actor, teamId: "other-synthetic-tenant" }, legacy()),
    ).rejects.toThrow("wrong tenant");
    expect(h.save).not.toHaveBeenCalled();
  });
  it("hashes ordered JSON with CRLF-only normalization, preserving Unicode and whitespace", () => {
    const p = {
      from: "FROM@EXAMPLE.INVALID",
      recipient: "TO@EXAMPLE.INVALID",
      subject: " é ",
      text: "e\u0301\r\nx  ",
    };
    const expected = createHash("sha256")
      .update(
        JSON.stringify({
          from: "from@example.invalid",
          recipient: "to@example.invalid",
          subject: p.subject,
          text: "e\u0301\nx  ",
        }),
      )
      .digest("hex");
    expect(mailboxPayloadSha256(p)).toBe(expected);
    expect(mailboxPayloadSha256({ ...p, text: "é\nx  " })).not.toBe(expected);
  });
  it("creates once with signature + mandatory footer and receipts actual saved bytes", async () => {
    const result = await saveMailboxContentDraft(db, actor, input());
    expect(result).toHaveProperty("composition");
    if (!("composition" in result)) throw new Error("missing receipt");
    const raw = h.items.get(draftId)!.raw;
    const mime = await parse(raw);
    expect(mime.text).toContain("--\nSynthetic Signature\n\nSynthetic mandatory optout");
    expect(result.composition.submittedPayloadSha256).toBe(
      mailboxPayloadSha256({ ...input(), from: h.box.address, recipient: input().to[0]! }),
    );
    expect(result.composition.composedPayloadSha256).toBe(
      mailboxPayloadSha256({
        ...input(),
        text: mime.text!,
        from: h.box.address,
        recipient: input().to[0]!,
      }),
    );
    expect(result.composition.composedMimeSha256).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(result.composition.submittedPayloadSha256).not.toBe(
      result.composition.composedPayloadSha256,
    );
    expect(h.save).toHaveBeenCalledTimes(1);
  });
  it("does not duplicate an already included signature", async () => {
    await saveMailboxContentDraft(db, actor, {
      ...input(),
      text: "Reply\n\n--\nSynthetic Signature",
    });
    expect(
      (await parse(h.items.get(draftId)!.raw)).text?.match(/Synthetic Signature/g),
    ).toHaveLength(1);
  });
  it("verifies legacy through identical composition without saving or sending, binding retained MIME", async () => {
    const created = await saveMailboxContentDraft(db, actor, input());
    h.save.mockClear();
    const receipt = await verifyMailboxDraftComposition(db, actor, legacy());
    expect("composition" in created && receipt).toEqual(
      "composition" in created ? created.composition : null,
    );
    expect(h.save).not.toHaveBeenCalled();
    const { mailboxId: _box, ...body } = legacy();
    const response = await POST(
      new Request("https://example.invalid/api/mailbox-agent/drafts/composition", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(await response.json()).toEqual({ composition: receipt });
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each([
    "Subject",
    "From",
    "To",
    "Cc",
    "Bcc",
    "In-Reply-To",
    "References",
    "X-Extra",
    "HTML",
    "TEXT",
    "ATTACHMENT",
  ])("rejects complete MIME drift: %s", async (field) => {
    await saveMailboxContentDraft(db, actor, input());
    h.save.mockClear();
    const row = h.items.get(draftId)!;
    if (field === "HTML" || field === "TEXT") {
      const str = row.raw.toString();
      row.raw = Buffer.from(
        str.replace(field === "HTML" ? "<p>" : "Ol", field === "HTML" ? "<p>Changed " : "XX"),
      );
    } else if (field === "ATTACHMENT") {
      row.raw = Buffer.from(
        row.raw
          .toString()
          .replace("Content-Type: multipart/alternative", "Content-Type: multipart/mixed")
          .replace(
            /\r\n--([^\r\n]+)--\r\n$/,
            "\r\n--$1\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=x\r\n\r\nx\r\n--$1--\r\n",
          ),
      );
    } else
      row.raw = Buffer.concat([Buffer.from(`${field}: attacker@example.invalid\r\n`), row.raw]);
    await expect(verifyMailboxDraftComposition(db, actor, legacy())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.save).not.toHaveBeenCalled();
  });
  it.each(["revision", "source", "mailbox", "signature", "policy", "read", "draft"])(
    "rejects stale binding/config/grants: %s",
    async (field) => {
      await saveMailboxContentDraft(db, actor, input());
      h.save.mockClear();
      let request = legacy();
      if (field === "revision") h.items.get(draftId)!.revision++;
      if (field === "source") request = { ...request, sourceItemId: draftId };
      if (field === "mailbox") request = { ...request, mailboxId: sourceId };
      if (field === "signature") h.box.signatureText = "Changed signature";
      if (field === "policy") h.policy = false;
      if (field === "read") h.box.canRead = false;
      if (field === "draft") h.box.canDraft = false;
      await expect(verifyMailboxDraftComposition(db, actor, request)).rejects.toBeTruthy();
      expect(h.save).not.toHaveBeenCalled();
    },
  );
  it("persists definitive ID before post-save revocation and never auto-recreates", async () => {
    h.afterSave.mockImplementation(async () => {
      h.box.canDraft = false;
    });
    await expect(saveMailboxContentDraft(db, actor, input())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(h.items.get(draftId)?.revision).toBe(1);
    expect(h.save).toHaveBeenCalledTimes(1);
  });
  it("refuses concurrent revision drift after saving", async () => {
    h.afterSave.mockImplementation(async () => {
      h.items.get(draftId)!.revision++;
    });
    await expect(saveMailboxContentDraft(db, actor, input())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.save).toHaveBeenCalledTimes(1);
  });
  it("retains old edit convention and omits v1 for unsupported/new human shapes", async () => {
    await saveMailboxContentDraft(db, actor, input());
    const edited = await saveMailboxContentDraft(db, actor, {
      ...input(),
      id: draftId,
      sourceItemId: draftId,
      expectedRevision: 1,
    });
    expect(edited).not.toHaveProperty("composition");
    expect(edited.revision).toBe(2);
    await expect(saveMailboxContentDraft(db, actor, { ...legacy() })).rejects.toMatchObject({
      code: "invalid",
    });
    expect(
      await saveMailboxContentDraft(db, { ...actor, agentAccess: undefined }, input()),
    ).not.toHaveProperty("composition");
  });
  it.each([
    { extra: true },
    { cc: [] },
    { html: "<p>x</p>" },
    { to: ["a@example.invalid", "b@example.invalid"] },
    { expectedRevision: 0 },
    { retainedAttachments: [0] },
  ])("strictly rejects unsupported verification JSON %j", async (extra) => {
    const { mailboxId: _box, ...body } = legacy();
    const response = await POST(
      new Request("https://example.invalid", {
        method: "POST",
        body: JSON.stringify({ ...body, ...extra }),
      }),
    );
    expect(response.status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("bounds verification body before parsing/auth", async () => {
    const response = await POST(
      new Request("https://example.invalid", { method: "POST", body: " ".repeat(1500001) }),
    );
    expect(response.status).toBe(413);
  });
  it("does not ignore source Message-ID drift between composing and attesting", async () => {
    await saveMailboxContentDraft(db, actor, input());
    h.save.mockClear();
    h.access.mockImplementationOnce(async (_db, _actor, _boxes, run) => {
      const row = h.items.get(sourceId)!;
      row.raw = Buffer.from(
        row.raw
          .toString()
          .replace("<source@example.invalid>", "<different-source@example.invalid>"),
      );
      return run(db);
    });
    await expect(verifyMailboxDraftComposition(db, actor, legacy())).rejects.toMatchObject({
      code: "conflict",
    });
    expect(h.save).not.toHaveBeenCalled();
  });
  it("accepts generated Date/Message-ID drift only while hashing exact retained raw", async () => {
    await saveMailboxContentDraft(db, actor, input());
    const row = h.items.get(draftId)!;
    const old = row.raw;
    row.raw = Buffer.from(
      old
        .toString()
        .replace(/^Date: .*$/m, "Date: Thu, 01 Jan 2026 00:00:00 +0000\r")
        .replace(/^Message-ID: .*$/im, "Message-ID: <changed@example.invalid>\r"),
    );
    expect(mailboxCompositionSemantics(await parse(row.raw))).toBe(
      mailboxCompositionSemantics(await parse(old)),
    );
    const receipt = await verifyMailboxDraftComposition(db, actor, legacy());
    expect(receipt.composedMimeSha256).toBe(createHash("sha256").update(row.raw).digest("hex"));
  });
});
