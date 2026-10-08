import { MailboxAgentAccessError } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All identities, bearers, provider seams and content are synthetic. These tests
// exercise the real Web admission paths without database, crypto or provider I/O.
const h = vi.hoisted(() => ({
  db: { synthetic: "database" },
  keys: { synthetic: "keyring" },
  actor: { teamId: "11111111-1111-4111-8111-111111111111", userId: "pilot_owner" },
  credentialError: null as Error | null,
  authCallbackActive: false,
  withAccess: vi.fn(),
  list: vi.fn(),
  createAgentKey: vi.fn(),
  recordSupportRead: vi.fn(),
  activity: vi.fn(),
  content: vi.fn(),
  contentList: vi.fn(),
  draft: vi.fn(),
  attachment: vi.fn(),
  queueDraft: vi.fn(),
  enqueue: vi.fn(),
  context: vi.fn(),
}));

vi.mock("@millionsend/core", async (original) => ({
  ...(await original<typeof import("@millionsend/core")>()),
  withMailboxAgentAccess: h.withAccess,
  listMailboxRegistry: h.list,
  createMailboxAgentKey: h.createAgentKey,
  queueMailboxAgentDraft: h.queueDraft,
  recordSupportViewRead: h.recordSupportRead,
  appendMailboxActivity: h.activity,
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => h.keys }));
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ send: h.enqueue }),
  enqueueEmailSend: vi.fn(),
  enqueueWebhookDeliveries: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (url: string) => url }));
// Direct caller fixtures supply their context instead of a framework request.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/server/locale", () => ({ activeLocale: async () => "en" }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: { synthetic: "mime" } }));
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: h.content,
  getMailboxContentList: h.contentList,
  saveMailboxContentDraft: h.draft,
  getMailboxAttachmentResponse: h.attachment,
  MAILBOX_PRIVATE_HEADERS: { "Cache-Control": "private, no-store" },
}));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: h.context,
}));

const { mailboxAccessEnabled } = await import("@/server/mailboxes");
const { mailboxesRouter } = await import("@/server/routers/mailboxes");
const { createCallerFactory, router } = await import("@/server/trpc");
const { GET: attachmentGet } = await import(
  "@/app/api/mailboxes/[mailboxId]/items/[id]/attachments/[index]/route"
);
const { GET: itemsGet } = await import("@/app/api/mailbox-agent/items/route");
const { POST: draftsPost } = await import("@/app/api/mailbox-agent/drafts/route");
const { POST: sendPost } = await import("@/app/api/mailbox-agent/send/route");
type Context = import("@/server/trpc").Context;

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";
const OWNER = "pilot_owner";
const BOX = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const TOKEN = `mmb_${BOX}.${"a".repeat(43)}`;
const as = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const draftInput = {
  expectedRevision: 0,
  to: ["recipient@example.invalid"],
  subject: "Offline pilot gate",
  text: "Synthetic content",
  retainedAttachments: [],
  uploads: [],
};
function context(teamId = TEAM, userId = OWNER, extra: Partial<Context> = {}): Context {
  return {
    db: h.db as unknown as Db,
    teamId,
    role: "owner",
    session: { user: { id: userId, name: "Synthetic owner", email: `${userId}@example.invalid` } },
    ...extra,
  };
}
function restrict() {
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", TEAM);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", OWNER);
}
function agentRequest(path: string, body?: unknown) {
  return new Request(`http://localhost/api/mailbox-agent/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function attachmentRequest() {
  return attachmentGet(
    new Request(`http://localhost/api/mailboxes/${BOX}/items/${ITEM}/attachments/0?revision=1`),
    { params: Promise.resolve({ mailboxId: BOX, id: ITEM, index: "0" }) },
  );
}
function contentNotTouched() {
  expect(h.content).not.toHaveBeenCalled();
  expect(h.contentList).not.toHaveBeenCalled();
  expect(h.draft).not.toHaveBeenCalled();
  expect(h.attachment).not.toHaveBeenCalled();
  expect(h.queueDraft).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "1");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", undefined);
  h.actor = { teamId: TEAM, userId: OWNER };
  h.credentialError = null;
  h.authCallbackActive = false;
  vi.clearAllMocks();
  h.context.mockResolvedValue(context());
  h.list.mockResolvedValue({ canManage: true, mailboxes: [] });
  h.createAgentKey.mockResolvedValue({ id: BOX });
  h.recordSupportRead.mockResolvedValue(undefined);
  h.activity.mockResolvedValue(undefined);
  h.content.mockResolvedValue({ id: ITEM, text: "Synthetic content" });
  h.contentList.mockResolvedValue({ items: [], limited: false });
  h.draft.mockResolvedValue({ id: ITEM, revision: 1, mailboxId: BOX });
  h.attachment.mockImplementation(async () => new Response("Synthetic attachment"));
  h.withAccess.mockImplementation(async (_db, _token, _scope, operation) => {
    if (h.credentialError) throw h.credentialError;
    h.authCallbackActive = true;
    try {
      return await operation({
        db: h.db,
        actor: { ...h.actor },
        mailboxId: BOX,
        keyId: BOX,
        ownerMembershipId: "55555555-5555-4555-8555-555555555555",
        expiresAt: null,
      });
    } finally {
      h.authCallbackActive = false;
    }
  });
  h.queueDraft.mockImplementation(async () => {
    // A second admission connection must not run inside the first auth lock.
    expect(h.authCallbackActive).toBe(false);
    return { id: ITEM, status: "queued", duplicate: false };
  });
  h.enqueue.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("operator mailbox pilot admission", () => {
  it("keeps the existing global behavior only when both pilot lists are absent", () => {
    expect(mailboxAccessEnabled({ teamId: OTHER_TEAM, userId: "other_owner" })).toBe(true);
    restrict();
    expect(mailboxAccessEnabled({ teamId: TEAM, userId: OWNER })).toBe(true);
    expect(mailboxAccessEnabled({ teamId: OTHER_TEAM, userId: OWNER })).toBe(false);
    expect(mailboxAccessEnabled({ teamId: TEAM, userId: "other_owner" })).toBe(false);
  });
  it("requires exact tokens while accepting multiple explicitly listed identities", () => {
    vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", ` ${TEAM}, ${OTHER_TEAM} `);
    vi.stubEnv("MAILBOX_PILOT_USER_IDS", ` ${OWNER}, other_owner `);
    expect(mailboxAccessEnabled({ teamId: OTHER_TEAM, userId: "other_owner" })).toBe(true);
    expect(mailboxAccessEnabled({ teamId: TEAM, userId: `${OWNER}_suffix` })).toBe(false);
    expect(mailboxAccessEnabled({ teamId: TEAM, userId: "pilot" })).toBe(false);
  });
  it.each([
    [TEAM, undefined],
    [undefined, OWNER],
    ["", OWNER],
    [TEAM, ""],
    ["   ", OWNER],
    [TEAM, "   "],
    ["not-a-team", OWNER],
    [`${TEAM},not-a-team`, OWNER],
    [TEAM, "owner@example.invalid"],
    [TEAM, "x".repeat(129)],
    [TEAM, `${OWNER},bad user`],
    [`${TEAM},`, OWNER],
    [TEAM, `${OWNER},`],
  ])("fails closed for partial or invalid lists (%s / %s)", (teams, users) => {
    vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", teams);
    vi.stubEnv("MAILBOX_PILOT_USER_IDS", users);
    expect(mailboxAccessEnabled({ teamId: TEAM, userId: OWNER })).toBe(false);
  });
  it("never overrides a disabled registry", () => {
    restrict();
    for (const flag of [undefined, "", "0", "false"]) {
      vi.stubEnv("MAILBOX_REGISTRY_ENABLED", flag);
      expect(mailboxAccessEnabled({ teamId: TEAM, userId: OWNER })).toBe(false);
    }
  });

  it.each([
    [OTHER_TEAM, OWNER],
    [TEAM, "other_owner"],
  ])(
    "denies real router capability and list/key procedures outside the pair",
    async (team, user) => {
      restrict();
      const caller = as(context(team, user)).mailboxes;
      expect(await caller.capabilities()).toEqual({
        enabled: false,
        deliveryReady: false,
        offered: false,
      });
      await expect(caller.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        caller.createAgentKey({ mailboxId: BOX, label: "Synthetic key" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(h.list).not.toHaveBeenCalled();
      expect(h.createAgentKey).not.toHaveBeenCalled();
    },
  );
  it("admits the paired owner through the real router while preserving support-view denial", async () => {
    restrict();
    const caller = as(context()).mailboxes;
    expect(await caller.capabilities()).toEqual({
      enabled: true,
      deliveryReady: true,
      offered: false,
    });
    expect(await caller.list()).toEqual({ canManage: true, mailboxes: [] });
    expect(h.list).toHaveBeenCalledExactlyOnceWith(h.db, { teamId: TEAM, userId: OWNER });
    const view = as(
      context(TEAM, OWNER, {
        supportView: { grantId: BOX, expiresAt: new Date(Date.now() + 60000) },
      }),
    ).mailboxes;
    expect(await view.capabilities()).toEqual({
      enabled: false,
      deliveryReady: false,
      offered: false,
    });
    await expect(view.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    [OTHER_TEAM, OWNER],
    [TEAM, "other_owner"],
  ])(
    "denies a direct private attachment outside the pair before content access",
    async (team, user) => {
      restrict();
      h.context.mockResolvedValue(context(team, user));
      expect((await attachmentRequest()).status).toBe(404);
      contentNotTouched();
    },
  );
  it("allows a paired attachment but never permits support-view private content", async () => {
    restrict();
    expect((await attachmentRequest()).status).toBe(200);
    expect(h.attachment).toHaveBeenCalledExactlyOnceWith(
      h.db,
      { teamId: TEAM, userId: OWNER },
      { mailboxId: BOX, id: ITEM, index: 0, preview: false, revision: 1 },
    );
    h.attachment.mockClear();
    h.context.mockResolvedValue(
      context(TEAM, OWNER, {
        supportView: { grantId: BOX, expiresAt: new Date(Date.now() + 60000) },
      }),
    );
    expect((await attachmentRequest()).status).toBe(403);
    contentNotTouched();
  });

  it.each([
    [OTHER_TEAM, OWNER],
    [TEAM, "other_owner"],
  ])(
    "denies bearer read, draft and send from an authenticated but unlisted pair",
    async (team, user) => {
      restrict();
      h.actor = { teamId: team, userId: user };
      expect((await itemsGet(agentRequest("items?folder=inbox"))).status).toBe(403);
      expect((await draftsPost(agentRequest("drafts", draftInput))).status).toBe(403);
      expect((await sendPost(agentRequest("send", { id: ITEM, expectedRevision: 1 }))).status).toBe(
        403,
      );
      // A refused send then tries to file an owner-approval request, which
      // needs draft access and is refused the same way.
      expect(h.withAccess.mock.calls.map((call) => call[2])).toEqual([
        "read",
        "draft",
        "send",
        "draft",
      ]);
      contentNotTouched();
    },
  );
  it("allows bearer read and draft with only the server-derived actor and mailbox", async () => {
    restrict();
    expect((await itemsGet(agentRequest("items?folder=inbox"))).status).toBe(200);
    expect(h.contentList).toHaveBeenCalledExactlyOnceWith(
      h.db,
      { teamId: TEAM, userId: OWNER },
      { mailboxId: BOX, folder: "inbox" },
    );
    expect((await draftsPost(agentRequest("drafts", draftInput))).status).toBe(200);
    expect(h.draft).toHaveBeenCalledExactlyOnceWith(
      h.db,
      { teamId: TEAM, userId: OWNER },
      {
        ...draftInput,
        mailboxId: BOX,
      },
    );
    expect(h.activity.mock.calls).toEqual([
      [
        h.db,
        { teamId: TEAM, mailboxId: BOX, actor: { kind: "mailbox_agent", keyId: BOX } },
        { action: "mailbox.items_listed", folder: "inbox", count: 0 },
      ],
      [
        h.db,
        { teamId: TEAM, mailboxId: BOX, actor: { kind: "mailbox_agent", keyId: BOX } },
        { action: "mailbox.draft_saved", itemId: ITEM, revision: 1 },
      ],
    ]);
    expect(h.queueDraft).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("passes an agent forward to the content service with a server-derived mailbox", async () => {
    restrict();
    const forward = {
      ...draftInput,
      sourceItemId: ITEM,
      mode: "forward",
      retainedAttachments: [0],
    };
    expect((await draftsPost(agentRequest("drafts", forward))).status).toBe(200);
    expect(h.draft).toHaveBeenCalledExactlyOnceWith(
      h.db,
      { teamId: TEAM, userId: OWNER },
      { ...forward, mailboxId: BOX },
    );
    expect(h.activity).toHaveBeenCalledExactlyOnceWith(
      h.db,
      { teamId: TEAM, mailboxId: BOX, actor: { kind: "mailbox_agent", keyId: BOX } },
      { action: "mailbox.draft_saved", itemId: ITEM, revision: 1 },
    );
    expect(h.queueDraft).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("rejects unsupported draft modes before credential or content work", async () => {
    restrict();
    expect(
      (await draftsPost(agentRequest("drafts", { ...draftInput, mode: "impersonate" }))).status,
    ).toBe(400);
    expect(h.withAccess).not.toHaveBeenCalled();
    contentNotTouched();
  });
  it("authenticates send before durable admission and enqueues only after releasing its first auth lock", async () => {
    restrict();
    const payload = { id: ITEM, expectedRevision: 1 };
    expect((await sendPost(agentRequest("send", payload))).status).toBe(202);
    // No MepMail-Mailbox header: no mailbox is named, the key's own is used.
    expect(h.withAccess).toHaveBeenCalledExactlyOnceWith(
      h.db,
      TOKEN,
      "send",
      expect.any(Function),
      null,
    );
    expect(h.queueDraft).toHaveBeenCalledExactlyOnceWith(
      h.db,
      h.keys,
      TOKEN,
      payload,
      { synthetic: "mime" },
      undefined,
      null,
    );
    expect(h.withAccess.mock.invocationCallOrder[0]).toBeLessThan(
      h.queueDraft.mock.invocationCallOrder[0]!,
    );
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(
      "mailbox.send",
      { outboxId: ITEM },
      { dedupeKey: ITEM },
    );
  });
  it("preserves credential rejection before content or outbox work", async () => {
    restrict();
    h.credentialError = new MailboxAgentAccessError("forbidden");
    expect((await itemsGet(agentRequest("items"))).status).toBe(403);
    expect((await draftsPost(agentRequest("drafts", draftInput))).status).toBe(403);
    expect((await sendPost(agentRequest("send", { id: ITEM, expectedRevision: 1 }))).status).toBe(
      403,
    );
    contentNotTouched();
  });
  it("keeps transport off for a listed owner without authenticating or enqueuing send", async () => {
    restrict();
    vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
    expect(await as(context()).mailboxes.capabilities()).toEqual({
      enabled: true,
      deliveryReady: false,
      offered: false,
    });
    expect((await sendPost(agentRequest("send", { id: ITEM, expectedRevision: 1 }))).status).toBe(
      404,
    );
    expect(h.withAccess).not.toHaveBeenCalled();
    contentNotTouched();
  });
  it("keeps registry off across real HTTP entry points", async () => {
    restrict();
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "0");
    expect((await attachmentRequest()).status).toBe(404);
    expect((await itemsGet(agentRequest("items"))).status).toBe(404);
    expect((await draftsPost(agentRequest("drafts", draftInput))).status).toBe(404);
    expect((await sendPost(agentRequest("send", { id: ITEM, expectedRevision: 1 }))).status).toBe(
      404,
    );
    expect(h.context).not.toHaveBeenCalled();
    expect(h.withAccess).not.toHaveBeenCalled();
    contentNotTouched();
  });
});
