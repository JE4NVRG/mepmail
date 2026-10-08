import {
  type MailboxAgentAccessContext,
  MailboxAgentAccessError,
  type MailboxAgentScope,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: { synthetic: "outer database" },
  tx: { synthetic: "authorized transaction" },
  access:
    vi.fn<
      (
        db: Db,
        token: string,
        scope: MailboxAgentScope,
        operation: (context: MailboxAgentAccessContext) => Promise<unknown>,
      ) => Promise<unknown>
    >(),
  audit: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@millionsend/core", async (original) => ({
  ...(await original<typeof import("@millionsend/core")>()),
  withMailboxAgentAccess: h.access,
  appendMailboxActivity: h.audit,
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContentList: h.list,
  getMailboxContent: h.read,
  saveMailboxContentDraft: h.save,
}));
// Import the actual Bearer/error boundary without loading MIME, queues, or private keyrings.
vi.mock("@/server/keyring", () => ({ getKeyring: () => ({ synthetic: "unused" }) }));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ synthetic: "unused" }) }));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: { synthetic: "unused" } }));

const { GET } = await import("@/app/api/mailbox-agent/items/route");
const { POST } = await import("@/app/api/mailbox-agent/drafts/route");
const teamId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const token = `mmb_${keyId}.${"a".repeat(43)}`;
const actor = { teamId, userId: "synthetic_owner", agentAccess: true as const };
const context: MailboxAgentAccessContext = {
  db: h.tx as unknown as Db,
  actor,
  mailboxId,
  keyId,
  ownerMembershipId: "55555555-5555-4555-8555-555555555555",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};
const auditContext = { teamId, mailboxId, actor: { kind: "mailbox_agent", keyId } };
const privateItem = {
  id: itemId,
  revision: 7,
  subject: "PRIVATE-SUBJECT",
  text: "PRIVATE-BODY",
  to: ["private-recipient@example.invalid"],
  contentTrust: "untrusted-message",
};
const draft = {
  expectedRevision: 0,
  to: ["private-recipient@example.invalid"],
  subject: "PRIVATE-SUBJECT",
  text: "PRIVATE-BODY",
  retainedAttachments: [],
  uploads: [],
};
function get(query = "", authorization = `Bearer ${token}`) {
  return GET(
    new Request(`http://localhost/api/mailbox-agent/items${query}`, { headers: { authorization } }),
  );
}
function post(body: unknown = draft, authorization = `Bearer ${token}`) {
  return POST(
    new Request("http://localhost/api/mailbox-agent/drafts", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  h.access.mockImplementation(async (_db, _token, _scope, operation) => operation(context));
  h.audit.mockResolvedValue(undefined);
  h.list.mockResolvedValue({ items: [privateItem, { ...privateItem, id: keyId }], limited: true });
  h.read.mockResolvedValue(privateItem);
  h.save.mockResolvedValue({ id: itemId, revision: 1, kind: "draft" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
function expectNoPrivateAuditPayload() {
  const serialized = JSON.stringify(h.audit.mock.calls);
  for (const value of [
    token,
    draft.subject,
    draft.text,
    draft.to[0],
    "subject",
    "recipients",
    "ownerMembershipId",
  ])
    expect(serialized).not.toContain(value);
}

describe("transaction-bound agent activity at REST boundaries", () => {
  it.each(["inbox", "drafts", "sent"])(
    "records %s listing from the authenticated transaction/key",
    async (folder) => {
      const response = await get(`?folder=${folder}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [privateItem, { ...privateItem, id: keyId }],
        limited: true,
      });
      // No MepMail-Mailbox header: no mailbox is named.
      expect(h.access).toHaveBeenCalledExactlyOnceWith(
        h.db,
        token,
        "read",
        expect.any(Function),
        null,
      );
      expect(h.list).toHaveBeenCalledExactlyOnceWith(h.tx, actor, { mailboxId, folder });
      expect(h.audit).toHaveBeenCalledExactlyOnceWith(h.tx, auditContext, {
        action: "mailbox.items_listed",
        folder,
        count: 2,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Authorization, MepMail-Mailbox");
      expectNoPrivateAuditPayload();
    },
  );

  it("records returned item ID/revision while preserving the authorized response", async () => {
    const response = await get(`?id=${itemId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(privateItem);
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.tx, actor, { mailboxId, id: itemId });
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(h.tx, auditContext, {
      action: "mailbox.item_read",
      itemId,
      revision: privateItem.revision,
    });
    expect(h.access.mock.calls[0]?.[2]).toBe("read");
    expect(h.list).not.toHaveBeenCalled();
    expectNoPrivateAuditPayload();
  });

  it("records the saved draft revision, never the submitted content or expected revision", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: itemId, revision: 1, kind: "draft" });
    // No MepMail-Mailbox header: no mailbox is named.
    expect(h.access).toHaveBeenCalledExactlyOnceWith(
      h.db,
      token,
      "draft",
      expect.any(Function),
      null,
    );
    expect(h.save).toHaveBeenCalledExactlyOnceWith(h.tx, actor, { ...draft, mailboxId });
    expect(h.audit).toHaveBeenCalledExactlyOnceWith(h.tx, auditContext, {
      action: "mailbox.draft_saved",
      itemId,
      revision: 1,
    });
    expectNoPrivateAuditPayload();
  });

  it.each(["list", "read", "draft"])(
    "fails closed if %s activity cannot be saved",
    async (operation) => {
      h.audit.mockRejectedValueOnce(new Error(`${token}: ${draft.subject} ${draft.text}`));
      const response =
        operation === "draft"
          ? await post()
          : await get(operation === "read" ? `?id=${itemId}` : "");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
      expect(h.audit).toHaveBeenCalledTimes(1);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expectNoPrivateAuditPayload();
      // Core transaction tests prove rollback; this test proves no successful private DTO escapes.
    },
  );

  it("does not record denied credentials, missing Bearer or Send API keys", async () => {
    for (const authorization of ["", `Bearer ms_${"a".repeat(32)}`]) {
      expect((await get("", authorization)).status).toBe(401);
      expect((await post(draft, authorization)).status).toBe(401);
    }
    expect(h.access).not.toHaveBeenCalled();
    h.access.mockRejectedValue(new MailboxAgentAccessError("forbidden"));
    expect((await get()).status).toBe(403);
    expect((await get(`?id=${itemId}`)).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("rejects invalid/unsafe queries and body overrides before auth or audit", async () => {
    for (const query of [
      "?folder=spam",
      "?folder=quarantine",
      "?id=bad",
      `?teamId=${teamId}`,
      `?mailboxId=${mailboxId}`,
      `?keyId=${keyId}`,
    ])
      expect((await get(query)).status).toBe(400);
    for (const body of [
      "{",
      { ...draft, mailboxId },
      { ...draft, teamId },
      { ...draft, keyId },
      { ...draft, to: [] },
    ])
      expect((await post(body)).status).toBe(400);
    expect((await post("x".repeat(1500001))).status).toBe(413);
    expect(h.access).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("does not record requests blocked by the closed registry or pilot allowlist", async () => {
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "0");
    expect((await get()).status).toBe(404);
    expect((await post()).status).toBe(404);
    expect(h.access).not.toHaveBeenCalled();
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
    vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", teamId);
    vi.stubEnv("MAILBOX_PILOT_USER_IDS", "another_user");
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
  it("throttles one credential per minute before any access or audit work", async () => {
    vi.stubEnv("MAILBOX_AGENT_RATE_LIMIT_PER_MINUTE", "2");
    const other = `Bearer mmb_${"r".repeat(40)}`;
    const throttled = `Bearer mmb_${"t".repeat(40)}`;
    expect((await get("", throttled)).status).toBe(200);
    expect((await get("", throttled)).status).toBe(200);
    h.access.mockClear();
    h.audit.mockClear();
    const limited = await get("", throttled);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("cache-control")).toBe("private, no-store");
    expect((await post(draft, throttled)).status).toBe(429);
    expect(h.access).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    // Another credential keeps its own window.
    expect((await get("", other)).status).toBe(200);
  });
});
