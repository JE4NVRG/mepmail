import { MailboxAgentAccessError, MailboxContentError } from "@millionsend/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: { synthetic: "database" },
  keys: { synthetic: "keyring" },
  queueDraft: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    status: "queued" as "queued" | "accepted",
    duplicate: false,
  })),
  enqueue: vi.fn(async () => {}),
}));
vi.mock("@millionsend/core", async (original) => {
  const core = await original<typeof import("@millionsend/core")>();
  return {
    ...core,
    queueMailboxAgentDraft: h.queueDraft,
    // A refused send asks the owner for approval, which needs draft access; the
    // synthetic key here has none, so the refusal stands. The approval path
    // itself is covered by mailbox-agent-send-approval.test.ts.
    withMailboxAgentAccess: async () => {
      throw new core.MailboxAgentAccessError("forbidden");
    },
  };
});
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => h.keys }));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ send: h.enqueue }) }));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: { synthetic: "mime" } }));

const { POST } = await import("@/app/api/mailbox-agent/send/route");
const id = "11111111-1111-4111-8111-111111111111";
const token = `mmb_${id}.${"a".repeat(43)}`;
const payload = { id, expectedRevision: 1 };
function request(body: unknown = payload, authorization = `Bearer ${token}`) {
  return new Request("http://localhost/api/mailbox-agent/send", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "1");
  h.queueDraft.mockReset();
  h.queueDraft.mockResolvedValue({ id, status: "queued", duplicate: false });
  h.enqueue.mockReset();
  h.enqueue.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restricted mailbox agent send endpoint", () => {
  it("uses bearer-derived admission and enqueues only a committed outbox ID", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(h.queueDraft).toHaveBeenCalledExactlyOnceWith(h.db, h.keys, token, payload, {
      synthetic: "mime",
    });
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(
      "mailbox.send",
      { outboxId: id },
      { dedupeKey: id },
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });
  it("rejects identity, mailbox, credential or MIME overrides and bounds the body before admission", async () => {
    for (const extra of [
      { mailboxId: id },
      { teamId: id },
      { userId: "owner" },
      { agentKeyId: id },
      { raw: "MIME" },
    ])
      expect((await POST(request({ ...payload, ...extra }))).status).toBe(400);
    expect((await POST(request({ id, expectedRevision: 0 }))).status).toBe(400);
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request("x".repeat(4097)))).status).toBe(413);
    expect(h.queueDraft).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("refuses Send keys, missing bearer or revoked credentials and preserves closed feature gates", async () => {
    for (const authorization of ["", "Bearer ms_" + "a".repeat(32)])
      expect((await POST(request(payload, authorization))).status).toBe(401);
    expect(h.queueDraft).not.toHaveBeenCalled();
    h.queueDraft.mockRejectedValueOnce(new MailboxAgentAccessError("forbidden"));
    expect((await POST(request())).status).toBe(403);
    h.queueDraft.mockClear();
    vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
    expect((await POST(request())).status).toBe(404);
    vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "1");
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "0");
    expect((await POST(request())).status).toBe(404);
    expect(h.queueDraft).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("returns conflicts safely and retries an enqueue failure without changing durable approval", async () => {
    h.queueDraft.mockRejectedValueOnce(new MailboxContentError("conflict"));
    expect((await POST(request())).status).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
    h.enqueue.mockRejectedValueOnce(new Error("synthetic queue unavailable"));
    expect((await POST(request())).status).toBe(503);
    h.queueDraft.mockResolvedValue({ id, status: "queued", duplicate: true });
    expect((await POST(request())).status).toBe(200);
    expect(h.enqueue.mock.calls[0]).toEqual(h.enqueue.mock.calls[1]);
    h.enqueue.mockClear();
    h.queueDraft.mockResolvedValue({ id, status: "accepted", duplicate: true });
    expect((await POST(request())).status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
