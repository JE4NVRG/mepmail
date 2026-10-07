import {
  type MailboxAgentAccessContext,
  MailboxAgentAccessError,
  type MailboxAgentScope,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each select on the authorized transaction answers the next queued result.
const h = vi.hoisted(() => {
  const answers: unknown[][] = [];
  const builder = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then")
            return (resolve: (rows: unknown[]) => void) => resolve(answers.shift() ?? []);
          return () => builder();
        },
      },
    );
  return {
    answers,
    tx: { select: () => builder() },
    access:
      vi.fn<
        (
          db: Db,
          token: string,
          scope: MailboxAgentScope,
          operation: (context: MailboxAgentAccessContext) => Promise<unknown>,
        ) => Promise<unknown>
      >(),
    queue: vi.fn(),
    audit: vi.fn(),
    claim: vi.fn(),
    mail: vi.fn(),
  };
});
vi.mock("@millionsend/core", async (original) => ({
  ...(await original<typeof import("@millionsend/core")>()),
  withMailboxAgentAccess: h.access,
  queueMailboxAgentDraft: h.queue,
  appendMailboxActivity: h.audit,
  claimNotification: h.claim,
  accountLocale: async () => "pt-BR",
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => ({ synthetic: "outer database" }),
}));
vi.mock("@/server/mailboxes", () => ({
  mailboxActorAccessEnabled: async () => true,
  mailboxRegistryEnabled: () => true,
}));
vi.mock("@/server/system-mail", () => ({
  accountEmailFrom: () => "MepMail <conta@mepmail.dev>",
  buildAccountEmail: (input: unknown) => input,
  sendAccountMail: h.mail,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => ({ synthetic: "unused" }) }));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({ send: async () => {} }) }));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: { synthetic: "unused" } }));

const { POST } = await import("@/app/api/mailbox-agent/send/route");
const teamId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const token = `mmb_${keyId}.${"a".repeat(43)}`;
const context = {
  db: h.tx as unknown as Db,
  actor: { teamId, userId: "owner", agentAccess: true as const },
  mailboxId,
  keyId,
  ownerMembershipId: "55555555-5555-4555-8555-555555555555",
  expiresAt: null,
} as unknown as MailboxAgentAccessContext;

const send = () =>
  POST(
    new Request("http://localhost/api/mailbox-agent/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: itemId, expectedRevision: 3 }),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  h.answers.length = 0;
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "1");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", undefined);
  // A key without the send scope: the send admission refuses it.
  h.queue.mockRejectedValue(new MailboxAgentAccessError("forbidden"));
  h.access.mockImplementation(async (_db, _token, scope, operation) => {
    if (scope === "send") throw new MailboxAgentAccessError("forbidden");
    return operation(context);
  });
  h.claim.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent send without the send permission", () => {
  it("records an approval request for the exact revision and mails the owner once", async () => {
    h.answers.push(
      [{ label: "Sage", scopes: ["read", "draft"] }],
      [{ kind: "draft", revision: 3, trashedAt: null }],
      [],
      [{ address: "agente@piloto.mepmail.dev", ownerEmail: "dono@example.com" }],
    );
    const res = await send();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "awaiting_approval",
      id: itemId,
      revision: 3,
      duplicate: false,
    });
    expect(h.audit).toHaveBeenCalledWith(
      h.tx,
      { teamId, mailboxId, actor: { kind: "mailbox_agent", keyId } },
      { action: "mailbox.send_requested", itemId, revision: 3 },
    );
    expect(h.mail).toHaveBeenCalledTimes(1);
    expect(h.mail.mock.calls[0]?.[0]).toMatchObject({
      to: "dono@example.com",
      kind: "mailbox.send_requested",
      locale: "pt-BR",
      values: { agent: "Sage", mailbox: "agente@piloto.mepmail.dev" },
    });
  });

  it("answers a repeated request as a duplicate, without a second record or notice", async () => {
    h.answers.push(
      [{ label: "Sage", scopes: ["read", "draft"] }],
      [{ kind: "draft", revision: 3, trashedAt: null }],
      [{ id: 1 }],
      [{ address: "agente@piloto.mepmail.dev", ownerEmail: "dono@example.com" }],
    );
    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).duplicate).toBe(true);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.mail).not.toHaveBeenCalled();
  });

  it("refuses a stale revision and keeps a send-scoped key's refusal", async () => {
    h.answers.push(
      [{ label: "Sage", scopes: ["read", "draft"] }],
      [{ kind: "draft", revision: 4, trashedAt: null }],
    );
    expect((await send()).status).toBe(409);
    h.answers.length = 0;
    h.answers.push([{ label: "Sender", scopes: ["read", "draft", "send"] }]);
    expect((await send()).status).toBe(403);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.mail).not.toHaveBeenCalled();
  });
});
