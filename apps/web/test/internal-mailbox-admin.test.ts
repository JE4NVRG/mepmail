import { randomBytes } from "node:crypto";
import {
  deriveInternalActorKey,
  INTERNAL_ACTOR_HEADER,
  signInternalActor,
} from "@millionsend/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  master: Buffer.from("0123456789abcdef0123456789abcdef"),
  list: vi.fn(),
  create: vi.fn(),
  key: vi.fn(),
  audit: vi.fn(),
  activate: vi.fn(),
  access: vi.fn(),
  createAccess: vi.fn(),
}));
vi.mock("@millionsend/config", async (original) => ({
  ...(await original<typeof import("@millionsend/config")>()),
  env: { MASTER_ENCRYPTION_KEY: h.master.toString("base64") },
}));
vi.mock("@millionsend/core", async (original) => ({
  ...(await original<typeof import("@millionsend/core")>()),
  listMailboxRegistry: h.list,
  createMailboxRegistry: h.create,
  createMailboxAgentKey: h.key,
  recordAudit: h.audit,
  withMailboxRegistryAdmin: async (_db: unknown, _actor: unknown, run: (tx: unknown) => unknown) =>
    run({ synthetic: "tx" }),
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => ({ synthetic: "db" }),
}));
vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: () => "https://api.example.test" }));
vi.mock("@/server/mailbox-activation", () => ({ activateMailboxReceiving: h.activate }));
vi.mock("@/server/mailboxes", () => ({
  mailboxActorAccessEnabled: h.access,
  mailboxCreateAccessEnabled: h.createAccess,
}));

const { POST } = await import("@/app/api/internal/mailbox-admin/route");
const key = deriveInternalActorKey(h.master);
const actor = { teamId: "11111111-1111-4111-8111-111111111111", userId: "owner" };
const call = (body: unknown, header: string | null = signInternalActor(key, actor)) =>
  POST(
    new Request("http://localhost/api/internal/mailbox-admin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { [INTERNAL_ACTOR_HEADER]: header } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  h.access.mockResolvedValue(true);
  h.createAccess.mockResolvedValue(true);
});

describe("internal mailbox admin", () => {
  it("refuses a request without a valid signed actor", async () => {
    expect((await call({ action: "list" }, null)).status).toBe(401);
    const forged = signInternalActor(deriveInternalActorKey(randomBytes(32)), actor);
    expect((await call({ action: "list" }, forged)).status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("lists the actor's mailboxes", async () => {
    h.list.mockResolvedValue({
      canManage: true,
      mailboxes: [
        {
          id: "m1",
          address: "agente@acme.dev",
          label: "Agente",
          kind: "agent",
          status: "planned",
          domainId: "d1",
          ownerUserId: "owner",
          canDraft: true,
          canSend: true,
        },
      ],
    });
    const res = await call({ action: "list" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      can_manage: true,
      mailboxes: [
        {
          id: "m1",
          address: "agente@acme.dev",
          label: "Agente",
          kind: "agent",
          status: "planned",
          domain_id: "d1",
          owned_by_you: true,
          can_draft: true,
          can_send: true,
        },
      ],
    });
    expect(h.list).toHaveBeenCalledWith({ synthetic: "db" }, actor);
  });

  it("creates a mailbox owned by the actor and starts receiving", async () => {
    h.create.mockResolvedValue({
      id: "m2",
      address: "suporte@acme.dev",
      kind: "agent",
      domainId: "d1",
    });
    h.activate.mockResolvedValue({ state: "needs_dns", added: 0 });
    const res = await call({
      action: "create",
      domainId: "22222222-2222-4222-8222-222222222222",
      localPart: "suporte",
      label: "Suporte",
    });
    expect(await res.json()).toEqual({
      id: "m2",
      address: "suporte@acme.dev",
      kind: "agent",
      receiving: "needs_dns",
    });
    expect(h.create.mock.calls[0]?.[2]).toMatchObject({ ownerUserId: "owner", kind: "agent" });
  });

  it("mints read/draft keys only, and returns the MCP command once", async () => {
    expect(
      (
        await call({
          action: "create_agent_key",
          mailboxId: "33333333-3333-4333-8333-333333333333",
          label: "Sage",
          scopes: ["read", "send"],
        })
      ).status,
    ).toBe(400);
    h.key.mockResolvedValue({
      id: "k1",
      mailboxId: "33333333-3333-4333-8333-333333333333",
      label: "Sage",
      scopes: ["read", "draft"],
      expiresAt: null,
      token: "mmb_token",
    });
    const res = await call({
      action: "create_agent_key",
      mailboxId: "33333333-3333-4333-8333-333333333333",
      label: "Sage",
    });
    const body = await res.json();
    expect(h.key.mock.calls[0]?.[2]).toMatchObject({ scopes: ["read", "draft"] });
    expect(body).toMatchObject({
      token: "mmb_token",
      mcp_url: "https://api.example.test/mcp/correio",
    });
    expect(body.claude_code_command).toContain("Bearer mmb_token");
  });

  it("answers 403 where Correio is not available to the team", async () => {
    h.access.mockResolvedValue(false);
    expect((await call({ action: "list" })).status).toBe(403);
  });
});
