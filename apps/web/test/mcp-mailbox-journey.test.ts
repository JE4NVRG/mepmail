import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addMailboxAlias,
  createMailboxRegistry,
  createMailboxTeamAgentKey,
  deriveInternalActorKey,
  grantMailboxOAuthClient,
  INTERNAL_ACTOR_HEADER,
  signInternalActor,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MailboxProvisioningClient,
  mailboxProtectedRuleSha256,
} from "../../../packages/ses/src/mailbox-provisioning";
import { seedMailboxTestService } from "./mailbox-service-fixture";

// The MCP mailbox journey through its public surfaces: the internal admin route the MCP
// server calls (check, create, grant_app, revoke_app) and the agent API the mailbox_*
// tools call, on a real database (Main + Mail migrations). Only the receiving provider
// (DNS, SES rule, identity) is a fake: no AWS, network or provider call is made.
type ReceiptRule = Parameters<typeof mailboxProtectedRuleSha256>[0];
const MX = "inbound-smtp.us-east-1.amazonaws.com";
const topic = "arn:aws:sns:us-east-1:123456789012:journey-fixture";
const initial: ReceiptRule = {
  Name: "fixture-journey-rule",
  Enabled: true,
  TlsPolicy: "Require",
  ScanEnabled: true,
  Recipients: ["support@existing.invalid"],
  Actions: [
    { S3Action: { BucketName: "fixture-private", ObjectKeyPrefix: "mail/", TopicArn: topic } },
  ],
};
const h = vi.hoisted(() => ({
  master: Buffer.from("0123456789abcdef0123456789abcdef"),
  db: null as unknown,
  rule: null as unknown,
  mx: [] as Array<{ exchange: string; priority: number }>,
  failActivation: false,
}));
vi.mock("@millionsend/config", async (original) => ({
  ...(await original<typeof import("@millionsend/config")>()),
  env: {
    MASTER_ENCRYPTION_KEY: h.master.toString("base64"),
    APP_BASE_URL: "https://example.invalid",
  },
  isCloudDeployment: () => true,
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/server/billing", () => ({
  getStripe: vi.fn(),
  getPixStripe: vi.fn(),
  pixPaymentsOpen: () => false,
}));
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (url: string) => url }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/queue", () => ({ getQueue: vi.fn() }));
vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: () => "https://api.example.invalid" }));
vi.mock("@/server/mailbox-receiving", () => ({
  mailboxReceivingDeps: () => ({
    configuration: () => ({ mxExchange: MX, ingressEnabled: true }),
    resolveMx: async () => h.mx,
    observe: async (domain: { id: string; teamId: string; name: string; region: string }) => ({
      domainId: domain.id,
      teamId: domain.teamId,
      domainName: domain.name,
      region: domain.region,
      checkedAt: new Date(),
      ruleSetActive: true,
      ruleEnabled: true,
      tlsRequired: true,
      scanEnabled: true,
      storageReady: true,
      notificationReady: true,
      recipients: ((h.rule as ReceiptRule).Recipients ?? []).filter((r) =>
        r.endsWith(`@${domain.name}`),
      ),
    }),
  }),
}));
vi.mock("@/server/mailbox-activation", async (original) => {
  const actual = await original<typeof import("@/server/mailbox-activation")>();
  return {
    ...actual,
    activateMailboxReceiving: (
      db: Db,
      actor: { teamId: string; userId: string },
      domain: string,
    ) => {
      if (h.failActivation) throw new Error("provider timeout (fixture)");
      const client: MailboxProvisioningClient = {
        async send(command) {
          if (!("Rule" in command.input))
            return { Metadata: { Name: "fixture-set" }, Rules: [structuredClone(h.rule)] };
          h.rule = structuredClone(command.input.Rule);
          return {};
        },
      } as MailboxProvisioningClient;
      return actual.activateMailboxReceiving(db, actor, domain, {
        configuration: JSON.stringify({
          version: 1,
          region: "us-east-1",
          ruleSetName: "fixture-set",
          ruleName: initial.Name,
          protectedRuleSha256: mailboxProtectedRuleSha256(initial),
        }),
        inbound: JSON.stringify({
          region: "us-east-1",
          topics: [topic],
          locations: [
            { bucket: "fixture-private", prefix: "mail/", ownerAccountId: "123456789012" },
          ],
        }),
        resolveMx: async () => h.mx,
        identity: async () => true,
        client: () => client,
      });
    },
  };
});

const { POST: admin } = await import("@/app/api/internal/mailbox-admin/route");
const { GET: accountsGet } = await import("@/app/api/mailbox-agent/mailboxes/route");
const { GET: itemsGet } = await import("@/app/api/mailbox-agent/items/route");
const { mailboxesRouter } = await import("@/server/routers/mailboxes");
const { createCallerFactory, router } = await import("@/server/trpc");
type Context = import("@/server/trpc").Context;

const key = deriveInternalActorKey(h.master);
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const owner = "journey_owner",
  member = "journey_member",
  stranger = "journey_stranger";
const APP = "hermes-agent-fixture";
let db: Db, close: () => Promise<void>;
let teamId: string, otherTeam: string, bareTeam: string;
let domainId: string, domainName: string, otherDomain: string, bareDomain: string, bareName: string;
let existing: string, colleagueBox: string, foreignBox: string;
let sequence = 0;

type Actor = { teamId: string; userId: string; clientId?: string };
const me = (extra: Partial<Actor> = {}): Actor => ({ teamId, userId: owner, ...extra });
async function call(body: unknown, actor: Actor = me({ clientId: APP })) {
  const response = await admin(
    new Request("http://localhost/api/internal/mailbox-admin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_ACTOR_HEADER]: signInternalActor(key, actor),
      },
      body: JSON.stringify(body),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: the route answers loose JSON; each test asserts its shape.
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
/** What the app's mailbox_* tools reach, through the agent API as the MCP server calls it. */
async function reach(clientId = APP) {
  const response = await accountsGet(
    new Request("http://localhost/api/mailbox-agent/mailboxes", {
      headers: { [INTERNAL_ACTOR_HEADER]: signInternalActor(key, me({ clientId })) },
    }),
  );
  if (response.status !== 200) return response.status;
  const body = (await response.json()) as { mailboxes: { address: string; scopes: string[] }[] };
  return body.mailboxes.map((box) => `${box.address}:${[...box.scopes].sort().join("+")}`).sort();
}
async function inbox(address: string, clientId = APP) {
  return (
    await itemsGet(
      new Request("http://localhost/api/mailbox-agent/items?folder=inbox", {
        headers: {
          [INTERNAL_ACTOR_HEADER]: signInternalActor(key, me({ clientId })),
          "mepmail-mailbox": address,
        },
      }),
    )
  ).status;
}
const dashboard = () =>
  createCallerFactory(router({ mailboxes: mailboxesRouter }))({
    db,
    teamId,
    role: "owner",
    session: { user: { id: owner, name: owner, email: `${owner}@example.invalid` } },
  } satisfies Context).mailboxes;
const audits = (action: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.teamId, teamId)));
const boxesAt = (address: string) =>
  db.select().from(schema.mailboxes).where(eq(schema.mailboxes.address, address));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  h.db = db;
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.execute(sql.raw(statement));
  await db
    .insert(schema.user)
    .values(
      [owner, member, stranger].map((id) => ({ id, name: id, email: `${id}@example.invalid` })),
    );
});
afterAll(async () => close());
beforeEach(async () => {
  sequence++;
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
  vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", undefined);
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  h.rule = structuredClone(initial);
  h.mx = [{ exchange: MX, priority: 10 }];
  h.failActivation = false;
  teamId = await createTeam(db, `journey-${sequence}`);
  otherTeam = await createTeam(db, `journey-other-${sequence}`);
  bareTeam = await createTeam(db, `journey-bare-${sequence}`);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: owner, role: "owner" },
    { teamId, userId: member, role: "member" },
    { teamId: otherTeam, userId: stranger, role: "owner" },
    { teamId: bareTeam, userId: stranger, role: "owner" },
  ]);
  // A license with 3 seats for the team; another licensed tenant; a tenant with none.
  await seedMailboxTestService(db, [teamId, otherTeam]);
  await db
    .update(schema.mailboxSubscriptions)
    .set({ seats: 3 })
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  domainName = `journey-${sequence}.example.invalid`;
  bareName = `journey-bare-${sequence}.example.invalid`;
  const [own, other, bare] = await db
    .insert(schema.domains)
    .values([
      { teamId, name: domainName, region: "us-east-1", status: "verified" },
      {
        teamId: otherTeam,
        name: `journey-other-${sequence}.example.invalid`,
        region: "us-east-1",
        status: "verified",
      },
      { teamId: bareTeam, name: bareName, region: "us-east-1", status: "verified" },
    ])
    .returning({ id: schema.domains.id });
  domainId = own!.id;
  otherDomain = other!.id;
  bareDomain = bare!.id;
  const box = async (team: string, by: string, domain: string, local: string, ownerId = by) =>
    (
      await createMailboxRegistry(
        db,
        { teamId: team, userId: by },
        { domainId: domain, localPart: local, label: local, kind: "agent", ownerUserId: ownerId },
      )
    ).id;
  existing = await box(teamId, owner, domainId, "existente");
  colleagueBox = await box(teamId, owner, domainId, "colega", member);
  foreignBox = await box(otherTeam, stranger, otherDomain, "alheia");
  // The person consented once: this app reads and drafts on "existente".
  await grantMailboxOAuthClient(
    db,
    { teamId, userId: owner },
    { clientId: APP, clientName: "Hermes Agent", mailboxIds: [existing] },
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checking a mailbox before creating it", () => {
  it("reports each layer for a free address, with when it was checked", async () => {
    const { status, body } = await call({ action: "check", domainId, localPart: "Suporte" });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      requester: { role: "owner", can_create_mailboxes: true },
      domain: { id: domainId, name: domainName, sending: "verified" },
      address: { address: `suporte@${domainName}`, valid: true, available: true, existing: null },
      license: { active: true, seats: 3, seats_used: 2, can_add_mailbox: true },
      receiving: { mx: { correio_host: MX, status: "ready", others: [] } },
      sending: { state: "ready" },
      ready: { registered: false, receiving: false, sending: false },
    });
    expect(Date.parse(body.checked_at)).not.toBeNaN();
    expect(body.receiving.checked_at).toBeTruthy();
    expect(body.actions.map((a: { code: string }) => a.code)).not.toContain("seat_required");
    expect(JSON.stringify(body)).not.toContain(topic);
  });

  it("names the existing mailbox, an alias or an invalid local part instead of guessing", async () => {
    const taken = await call({ action: "check", domainId, localPart: "existente" });
    expect(taken.body.address).toMatchObject({
      available: false,
      existing: { mailbox_id: existing, kind: "agent", state: "active", owned_by_you: true },
    });
    await addMailboxAlias(
      db,
      { teamId, userId: owner },
      { mailboxId: existing, localPart: "apelido" },
    );
    const alias = await call({ action: "check", domainId, localPart: "apelido" });
    expect(alias.body.address.existing).toEqual({ alias_of: existing });
    expect(alias.body.actions.map((a: { code: string }) => a.code)).toContain("address_is_alias");
    const bad = await call({ action: "check", domainId, localPart: "a..b" });
    expect(bad.body.address.valid).toBe(false);
    expect(bad.body.actions.map((a: { code: string }) => a.code)).toContain("invalid_local_part");
  });

  it("treats a backup MX of another provider as reported, a foreign primary as blocking", async () => {
    h.mx = [
      { exchange: MX, priority: 10 },
      { exchange: "mx2.titan.example.invalid", priority: 20 },
    ];
    const backup = await call({ action: "check", domainId, localPart: "existente" });
    expect(backup.body.receiving.mx.status).toBe("ready");
    expect(backup.body.receiving.mx.others).toEqual([
      { exchange: "mx2.titan.example.invalid", priority: 20 },
    ]);
    expect(backup.body.receiving.note).toContain("primary MX");
    h.mx = [
      { exchange: "mx1.titan.example.invalid", priority: 5 },
      { exchange: MX, priority: 10 },
    ];
    const primary = await call({ action: "check", domainId, localPart: "existente" });
    expect(primary.body.receiving.reasons).toContain("mx_conflict");
    expect(primary.body.actions.map((a: { code: string }) => a.code)).toContain("mx_conflict");
    expect(primary.body.ready.receiving).toBe(false);
  });

  it("answers a member, another tenant's domain and a team without a license honestly", async () => {
    const asMember = await call(
      { action: "check", domainId, localPart: "x" },
      me({ userId: member }),
    );
    expect(asMember.body.requester).toEqual({ role: "member", can_create_mailboxes: false });
    expect(asMember.body.receiving.state).toBe("unknown");
    expect((await call({ action: "check", domainId: otherDomain, localPart: "x" })).status).toBe(
      404,
    );
    const unlicensed = await call(
      { action: "check", domainId: bareDomain, localPart: "nova" },
      { teamId: bareTeam, userId: stranger },
    );
    expect(unlicensed.body.license).toMatchObject({
      active: false,
      can_add_mailbox: false,
      purchase_required: true,
      purchase_where: expect.stringContaining("/settings/billing"),
    });
    expect(unlicensed.body.actions.map((a: { code: string }) => a.code)).toContain(
      "license_required",
    );
  });
});

describe("creating a mailbox through the MCP", () => {
  it("creates once, then reconciles a repeat into the same mailbox (never a duplicate)", async () => {
    const first = await call({
      action: "create",
      domainId,
      localPart: "suporte",
      label: "Suporte",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      address: `suporte@${domainName}`,
      kind: "agent",
      created: true,
      reconciled: false,
      receiving: "confirmed",
      readiness: { ready: { registered: true, receiving: true, sending: true } },
    });
    expect((h.rule as ReceiptRule).Recipients).toContain(`suporte@${domainName}`);
    const again = await call({
      action: "create",
      domainId,
      localPart: "suporte",
      label: "Suporte",
    });
    expect(again.body).toMatchObject({ id: first.body.id, created: false, reconciled: true });
    expect(await boxesAt(`suporte@${domainName}`)).toHaveLength(1);
    const created = await audits("mailbox.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.data).toMatchObject({ via: "mcp", clientId: APP });
  });

  it("reconciles two concurrent creates of the same address to one mailbox", async () => {
    const both = await Promise.all([
      call({ action: "create", domainId, localPart: "duo", label: "Duo" }),
      call({ action: "create", domainId, localPart: "duo", label: "Duo" }),
    ]);
    expect(both.map((r) => [r.status, r.body.error ?? null, r.body.reason ?? null])).toEqual([
      [200, null, null],
      [200, null, null],
    ]);
    expect(new Set(both.map((r) => r.body.id)).size).toBe(1);
    expect(both.filter((r) => r.body.created).length).toBe(1);
    expect(await boxesAt(`duo@${domainName}`)).toHaveLength(1);
  });

  it("after an ambiguous failure (receiving not confirmed), a retry lists the address", async () => {
    h.failActivation = true;
    const lost = await call({ action: "create", domainId, localPart: "retry", label: "Retry" });
    expect(lost.body).toMatchObject({ created: true, receiving: "unknown" });
    expect(lost.body.readiness.ready).toMatchObject({ registered: true, receiving: false });
    expect(lost.body.readiness.actions.map((a: { code: string }) => a.code)).toContain(
      "list_address",
    );
    h.failActivation = false;
    const retry = await call({ action: "create", domainId, localPart: "retry", label: "Retry" });
    expect(retry.body).toMatchObject({
      id: lost.body.id,
      created: false,
      reconciled: true,
      receiving: "confirmed",
      readiness: { ready: { registered: true, receiving: true } },
    });
  });

  it("refuses other settings on a taken address, an alias, a foreign domain and no free seat", async () => {
    const person = await call({
      action: "create",
      domainId,
      localPart: "existente",
      label: "X",
      kind: "person",
    });
    expect(person.status).toBe(409);
    expect(person.body).toMatchObject({
      error: "conflict",
      reason: "exists_with_other_settings",
      existing: { mailbox_id: existing, kind: "agent" },
    });
    const colleague = await call({ action: "create", domainId, localPart: "colega", label: "X" });
    expect(colleague.body).toMatchObject({ error: "conflict", existing: { owned_by_you: false } });
    await addMailboxAlias(
      db,
      { teamId, userId: owner },
      { mailboxId: existing, localPart: "apelido" },
    );
    const alias = await call({ action: "create", domainId, localPart: "apelido", label: "X" });
    expect(alias).toEqual({ status: 409, body: { error: "conflict", reason: "address_is_alias" } });
    const foreign = await call({
      action: "create",
      domainId: otherDomain,
      localPart: "x",
      label: "X",
    });
    expect(foreign.status).toBe(404);
    // 2 of 3 seats are used: one more fits, the next is refused and nothing is bought.
    expect((await call({ action: "create", domainId, localPart: "tres", label: "3" })).status).toBe(
      200,
    );
    const full = await call({ action: "create", domainId, localPart: "quatro", label: "4" });
    expect(full.status).toBe(409);
    expect(await boxesAt(`quatro@${domainName}`)).toHaveLength(0);
    const check = await call({ action: "check", domainId, localPart: "quatro" });
    expect(check.body.license).toMatchObject({ can_add_mailbox: false, purchase_required: true });
    expect(check.body.actions.map((a: { code: string }) => a.code)).toContain("seat_required");
    const unlicensed = await call(
      { action: "create", domainId: bareDomain, localPart: "nova", label: "N" },
      { teamId: bareTeam, userId: stranger },
    );
    expect([403, 409]).toContain(unlicensed.status);
    expect(await boxesAt(`nova@${bareName}`)).toHaveLength(0);
  });

  it("adds the new mailbox to this app's access when asked, without reconnecting", async () => {
    expect(await reach()).toEqual([`existente@${domainName}:draft+read`]);
    const made = await call({
      action: "create",
      domainId,
      localPart: "agente",
      label: "Agente",
      grantToThisApp: ["read", "draft"],
    });
    expect(made.body.agent_access).toMatchObject({ granted: true, changed: true });
    expect(await reach()).toEqual([
      `agente@${domainName}:draft+read`,
      `existente@${domainName}:draft+read`,
    ]);
    expect(await inbox(`agente@${domainName}`)).toBe(200);
    // Another app the person never connected gets nothing.
    expect(await reach("another-app")).toBe(403);
  });
});

describe("editing this app's mail access", () => {
  it("grants, narrows and revokes one mailbox; other credentials stay as they were", async () => {
    const extra = (
      await createMailboxRegistry(
        db,
        { teamId, userId: owner },
        { domainId, localPart: "extra", label: "Extra", kind: "agent", ownerUserId: owner },
      )
    ).id;
    const leo = await createMailboxTeamAgentKey(
      db,
      { teamId, userId: owner },
      { label: "Leo", mailboxIds: [existing, extra] },
    );
    const leoRows = async () =>
      JSON.stringify(
        await db
          .select()
          .from(schema.mailboxAgentKeys)
          .where(eq(schema.mailboxAgentKeys.groupId, leo.id)),
      );
    const leoBefore = await leoRows();
    const before = (await dashboard().teamAgentKeys()).find((k) => k.oauthClientId === APP)!;

    expect(await call({ action: "grant_app", mailboxId: extra, scopes: ["read"] })).toEqual({
      status: 200,
      body: { mailbox_id: extra, scopes: ["read"], changed: true },
    });
    expect(await reach()).toEqual([
      `existente@${domainName}:draft+read`,
      `extra@${domainName}:read`,
    ]);
    // The same request again changes nothing (and is not audited twice).
    expect(
      (await call({ action: "grant_app", mailboxId: extra, scopes: ["read"] })).body.changed,
    ).toBe(false);
    // A dashboard edit made before this change is refused, not silently overwritten.
    await expect(
      dashboard().updateTeamAgentKey({
        id: before.id,
        expectedVersion: before.version,
        label: "Hermes (editado)",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect((await call({ action: "revoke_app", mailboxId: extra })).body).toEqual({
      mailbox_id: extra,
      scopes: null,
      changed: true,
    });
    expect(await reach()).toEqual([`existente@${domainName}:draft+read`]);
    expect(await inbox(`extra@${domainName}`)).toBe(403);
    expect(await inbox(`existente@${domainName}`)).toBe(200);
    expect(await call({ action: "revoke_app", mailboxId: existing })).toMatchObject({
      status: 409,
      body: { error: "last_mailbox" },
    });

    expect(await leoRows()).toBe(leoBefore);
    const changes = await audits("mailbox.team_agent_key_updated");
    expect(changes.map((a) => a.data)).toEqual([
      { via: "mcp", clientId: APP, added: [extra], scopes: ["read"] },
      { via: "mcp", clientId: APP, removed: [extra] },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/mm[bt]_/);
  });

  it("refuses what the app may not reach: other owners, other tenants, beyond its grant", async () => {
    expect(await call({ action: "grant_app", mailboxId: colleagueBox, scopes: ["read"] })).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
    expect(await call({ action: "grant_app", mailboxId: foreignBox, scopes: ["read"] })).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
    // Sending is never granted here: the schema accepts read and draft only.
    expect(
      (await call({ action: "grant_app", mailboxId: existing, scopes: ["read", "send"] })).status,
    ).toBe(400);
    // Narrowed to read everywhere, the app cannot widen itself back to draft.
    await call({ action: "grant_app", mailboxId: existing, scopes: ["read"] });
    const extra = (
      await createMailboxRegistry(
        db,
        { teamId, userId: owner },
        { domainId, localPart: "extra", label: "Extra", kind: "agent", ownerUserId: owner },
      )
    ).id;
    expect(await call({ action: "grant_app", mailboxId: extra, scopes: ["draft"] })).toEqual({
      status: 403,
      body: { error: "forbidden" },
    });
    // No consent for this app, and no app at all (a bearer-key MCP session).
    expect(
      await call(
        { action: "grant_app", mailboxId: existing, scopes: ["read"] },
        me({ clientId: "nope" }),
      ),
    ).toMatchObject({ status: 409, body: { error: "no_mail_grant" } });
    expect(
      await call({ action: "grant_app", mailboxId: existing, scopes: ["read"] }, me()),
    ).toEqual({
      status: 403,
      body: { error: "oauth_only" },
    });
    expect(await audits("mailbox.team_agent_key_updated")).toHaveLength(1);
  });
});
