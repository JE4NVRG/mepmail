import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as activation from "@/server/mailbox-activation";
import { mailboxReceivingDeps } from "@/server/mailbox-receiving";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import type { SendBillingContract } from "../../../packages/core/src/send-billing-contract";
import {
  type MailboxProvisioningClient,
  mailboxProtectedRuleSha256,
} from "../../../packages/ses/src/mailbox-provisioning";
import { reconcileMailboxReceivingHolds } from "../../worker/src/handlers/mailbox-receiving-holds";
import { seedMailboxTestService } from "./mailbox-service-fixture";

type ReceiptRule = Parameters<typeof mailboxProtectedRuleSha256>[0];
const isUpdate = (command: unknown): boolean =>
  !!command &&
  typeof command === "object" &&
  command.constructor.name === "UpdateReceiptRuleCommand";

vi.mock("@millionsend/config", () => ({
  env: { STRIPE_SECRET_KEY: "sk_test_offline_activation", APP_BASE_URL: "https://example.invalid" },
  isCloudDeployment: () => true,
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/server/billing", () => ({ getStripe: vi.fn() }));
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (url: string) => url }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: vi.fn(),
  getMailboxContentList: vi.fn(),
  saveMailboxContentDraft: vi.fn(),
}));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: {} }));
vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/queue", () => ({ getQueue: vi.fn() }));
vi.mock("@/server/mailbox-receiving", () => ({ mailboxReceivingDeps: vi.fn() }));

// Real Main/Mail migrations, ACL, licenses, router, activation and SES commands.
// DNS/identity/client are injected fakes: no AWS/network/provider call is made.
const topic = "arn:aws:sns:us-east-1:123456789012:activation-fixture";
const initial: ReceiptRule = {
  Name: "fixture-existing-rule",
  Enabled: true,
  TlsPolicy: "Require",
  ScanEnabled: true,
  Recipients: ["support@existing.invalid"],
  Actions: [
    {
      S3Action: {
        BucketName: "fixture-private-existing",
        ObjectKeyPrefix: "mail/",
        TopicArn: topic,
      },
    },
  ],
};
const config = JSON.stringify({
  version: 1,
  region: "us-east-1",
  ruleSetName: "fixture-existing-set",
  ruleName: initial.Name,
  protectedRuleSha256: mailboxProtectedRuleSha256(initial),
});
const inbound = JSON.stringify({
  region: "us-east-1",
  topics: [topic],
  locations: [
    {
      bucket: "fixture-private-existing",
      prefix: "mail/",
      ownerAccountId: "123456789012",
    },
  ],
});
const actualActivate = activation.activateMailboxReceiving;
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const owner = "activation_fixture_owner",
  member = "activation_fixture_member";
let db: Db,
  close: () => Promise<void>,
  teamId: string,
  otherTeam: string,
  domainId: string,
  foreignDomain: string;
let first: string,
  second: string,
  domainName: string,
  currentRule: ReceiptRule,
  commands: unknown[];
let resolveMx: ReturnType<
  typeof vi.fn<(domain: string) => Promise<Array<{ exchange: string; priority: number }>>>
>;
let identity: ReturnType<typeof vi.fn<(domain: string) => Promise<boolean>>>;
let client: MailboxProvisioningClient;
let sequence = 0;
const as = (userId = owner) =>
  caller({
    db,
    teamId,
    role: "owner",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  } satisfies Context).mailboxes;
const verify = (domain = domainId) => as().verifyReceiving({ domainId: domain });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.execute(sql.raw(statement));
  await db
    .insert(schema.user)
    .values([owner, member].map((id) => ({ id, name: id, email: `${id}@example.invalid` })));
});
afterAll(async () => close());
beforeEach(async () => {
  sequence++;
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
  vi.stubEnv("BILLING_MUTATIONS_PAUSED", "true");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  teamId = await createTeam(db, `activation-fixture-${sequence}`);
  otherTeam = await createTeam(db, `activation-other-${sequence}`);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: owner, role: "owner" },
    { teamId, userId: member, role: "member" },
    { teamId: otherTeam, userId: member, role: "owner" },
  ]);
  const start = new Date("2020-01-01"),
    end = new Date("2030-01-01");
  const contract: SendBillingContract = {
    version: 1,
    teamId,
    customerId: `cus_activation_${sequence}`,
    subscriptionId: `sub_activation_${sequence}`,
    baseItemId: `si_activation_${sequence}`,
    basePriceId: "price_verified_sending_fixture",
    currency: "usd",
    baseAmountCents: 2900,
    regularMonthlyCents: 2900,
    included: 110000,
    usageInterval: "month",
    billingInterval: "month",
    intervalCount: 1,
    financialPeriodStart: start.toISOString(),
    financialPeriodEnd: end.toISOString(),
    usageAnchor: start.toISOString(),
    verifiedAt: new Date().toISOString(),
  };
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planStatus: "active",
      stripeCustomerId: contract.customerId,
      stripeSubscriptionId: contract.subscriptionId,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      sendBillingContract: contract,
    })
    .where(eq(schema.teams.id, teamId));
  vi.stubEnv(
    "MAILBOX_EARLY_ACCESS_COHORT",
    JSON.stringify({
      version: 1,
      capturedAt: "2020-01-02T00:00:00.000Z",
      members: [
        { teamId, customerId: contract.customerId, subscriptionId: contract.subscriptionId },
      ],
    }),
  );
  await seedMailboxTestService(db, [teamId]);
  domainName = `activation-${sequence}.example.invalid`;
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: domainName, region: "us-east-1", status: "verified" },
      {
        teamId: otherTeam,
        name: `other-activation-${sequence}.example.invalid`,
        region: "us-east-1",
        status: "verified",
      },
    ])
    .returning({ id: schema.domains.id });
  const ownDomain = domains[0],
    otherDomain = domains[1];
  if (!ownDomain || !otherDomain) throw new Error("Missing activation fixture domains");
  domainId = ownDomain.id;
  foreignDomain = otherDomain.id;
  first = (
    await as().create({
      domainId,
      localPart: "first",
      label: "First",
      kind: "agent",
      ownerUserId: owner,
    })
  ).id;
  second = (
    await as().create({
      domainId,
      localPart: "second",
      label: "Second",
      kind: "person",
      ownerUserId: owner,
    })
  ).id;
  await db
    .update(schema.mailboxes)
    .set({ createdAt: new Date("2000-01-01") })
    .where(eq(schema.mailboxes.id, first));
  await db
    .update(schema.mailboxes)
    .set({ createdAt: new Date("2001-01-01") })
    .where(eq(schema.mailboxes.id, second));
  currentRule = structuredClone(initial);
  commands = [];
  resolveMx = vi.fn(async () => [
    { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
  ]);
  identity = vi.fn(async () => true);
  client = {
    async send(command) {
      commands.push(command);
      if (!("Rule" in command.input))
        return {
          Metadata: { Name: "fixture-existing-set" },
          Rules: [structuredClone(currentRule)],
        };
      const updated = command.input.Rule;
      if (!updated) throw new Error("Missing receipt rule in fixture");
      currentRule = structuredClone(updated);
      return {};
    },
  };
  vi.spyOn(activation, "activateMailboxReceiving").mockImplementation((database, actor, domain) =>
    actualActivate(database, actor, domain, {
      configuration: config,
      inbound,
      resolveMx,
      identity,
      client: () => client,
    }),
  );
  vi.mocked(mailboxReceivingDeps).mockReturnValue({
    configuration: () => ({
      mxExchange: "inbound-smtp.us-east-1.amazonaws.com",
      ingressEnabled: true,
    }),
    resolveMx,
    observe: async (domain) => ({
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
      recipients: (currentRule.Recipients ?? []).filter((r) => r.endsWith(`@${domain.name}`)),
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("explicit licensed receiving activation", () => {
  it("keeps receiving query read-only and activates only through the mutation", async () => {
    const before = await as().receiving({ domainId });
    expect(before.mailboxes.every((box) => box.receiving_state === "reserved")).toBe(true);
    expect(commands).toHaveLength(0);
    const after = await verify();
    expect(after.state).toBe("ready");
    expect(after.mailboxes.every((box) => box.receiving_state === "ready")).toBe(true);
    expect(currentRule.Recipients).toEqual(
      [`first@${domainName}`, `second@${domainName}`, "support@existing.invalid"].sort(),
    );
    expect(currentRule.Actions).toEqual(initial.Actions);
    expect(commands.filter(isUpdate)).toHaveLength(1);
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain(topic);
    expect(serialized).not.toContain("fixture-private-existing");
    expect(serialized).not.toContain("fixture-existing-rule");
  });
  it("does not reissue a mutation after the licensed addresses are already present", async () => {
    await verify();
    await verify();
    expect(commands.filter(isUpdate)).toHaveLength(1);
  });
  it("rejects a cross-team domain before DNS or SES", async () => {
    await expect(verify(foreignDomain)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(resolveMx).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });
  it("rechecks the administrative role instead of trusting the caller context", async () => {
    await expect(as(member).verifyReceiving({ domainId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(commands).toHaveLength(0);
    expect(resolveMx).not.toHaveBeenCalled();
  });
  it("rejects an inactive paid add-on before provider calls", async () => {
    await db
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(verify()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(commands).toHaveLength(0);
    expect(resolveMx).not.toHaveBeenCalled();
  });
  it("revalidates paid-active Envio before a new receiving activation", async () => {
    await db
      .update(schema.teams)
      .set({ planStatus: "past_due" })
      .where(eq(schema.teams.id, teamId));
    await expect(verify()).rejects.toMatchObject({ message: "sending_plan_required" });
    expect(commands).toHaveLength(0);
    expect(resolveMx).not.toHaveBeenCalled();
  });
  it("does not activate when MX conflicts with another provider", async () => {
    resolveMx.mockResolvedValue([{ exchange: "other-provider.example.invalid", priority: 10 }]);
    expect((await verify()).state).toBe("needs_mx");
    expect(commands).toHaveLength(0);
  });
  it("does not activate an identity that SES has not verified", async () => {
    identity.mockResolvedValue(false);
    expect((await verify()).mailboxes.every((box) => box.receiving_state === "reserved")).toBe(
      true,
    );
    expect(commands).toHaveLength(0);
  });
  it("adds only the currently allocated seat and reports the other box reserved", async () => {
    await db
      .update(schema.mailboxSubscriptions)
      .set({ seats: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    const after = await verify();
    expect(currentRule.Recipients).toEqual(
      [`first@${domainName}`, "support@existing.invalid"].sort(),
    );
    expect(after.mailboxes.find((box) => box.id === first)?.receiving_state).toBe("ready");
    expect(after.mailboxes.find((box) => box.id === second)?.reasons).toContain(
      "seat_not_licensed",
    );
  });
  it("lists a licensed box's aliases in the SES rule as soon as they are added", async () => {
    await verify();
    const added = await as().addAlias({ mailboxId: second, localPart: "help" });
    expect(added).toMatchObject({ address: `help@${domainName}`, receiving: "confirmed" });
    expect(currentRule.Recipients).toEqual(
      [
        `first@${domainName}`,
        `help@${domainName}`,
        `second@${domainName}`,
        "support@existing.invalid",
      ].sort(),
    );
    expect(commands.filter(isUpdate)).toHaveLength(2);
    // An alias of a box without a licensed seat waits with its box.
    await db
      .update(schema.mailboxSubscriptions)
      .set({ seats: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await as().addAlias({ mailboxId: second, localPart: "sales" });
    await verify();
    expect(currentRule.Recipients).not.toContain(`sales@${domainName}`);
    expect(commands.filter(isUpdate)).toHaveLength(2);
  });
  it("rejects boxes whose owner membership is no longer current", async () => {
    await db
      .update(schema.mailboxes)
      .set({ ownerMembershipId: null })
      .where(eq(schema.mailboxes.teamId, teamId));
    await expect(verify()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(commands).toHaveLength(0);
    expect(resolveMx).not.toHaveBeenCalled();
  });
  it("normalizes unknown provider errors without disclosing private identifiers", async () => {
    client.send = async () => {
      throw new Error(`private-provider-failure:${topic}`);
    };
    await expect(verify()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "receiving_unavailable",
    });
    expect(currentRule.Recipients).toEqual(initial.Recipients);
  });
});

describe("receiving holds of a plan out of inbound allowance", () => {
  const reconcile = () =>
    reconcileMailboxReceivingHolds(db, { configuration: config, client: () => client });
  const subscriptionRow = async () =>
    (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0]!;
  const holdRow = async () =>
    (
      await db
        .select()
        .from(schema.mailboxReceivingHolds)
        .where(eq(schema.mailboxReceivingHolds.teamId, teamId))
    )[0];
  /** Turn the seeded license into a Duo plan that received `deliveries` this period. */
  const planOverAllowance = async (deliveries: number, allowance = 10) => {
    const sub = await subscriptionRow();
    await db
      .update(schema.mailboxSubscriptions)
      .set({
        planCode: "duo",
        quotaScope: "team",
        includedMailboxes: 3,
        inboundDeliveriesPerPeriod: allowance,
        inboundBytesPerPeriod: 10 ** 9,
        outboundBytesPerPeriod: 10 ** 9,
      })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await db.insert(schema.mailboxUsagePeriods).values({
      teamId,
      periodStart: sub.periodStart,
      periodEnd: sub.periodEnd,
      inboundDeliveries: deliveries,
      inboundBytes: 0,
    });
    await db
      .insert(schema.mailboxReceivingHolds)
      .values({ teamId, reason: "inbound_deliveries", periodEnd: sub.periodEnd });
  };

  it("takes the team out of SES, keeps activation from putting it back, and restores it", async () => {
    await verify();
    const addresses = [`first@${domainName}`, `second@${domainName}`];
    expect(currentRule.Recipients).toEqual([...addresses, "support@existing.invalid"].sort());
    await planOverAllowance(11);
    expect(await reconcile()).toEqual({ paused: 1, resumed: 0, failed: 0 });
    // SES now refuses their mail before accepting it; other routes are untouched.
    expect(currentRule.Recipients).toEqual(["support@existing.invalid"]);
    expect(currentRule.Actions).toEqual(initial.Actions);
    expect(await holdRow()).toMatchObject({ state: "paused", recipients: addresses });
    // Activating while paused writes nothing to SES; the addresses wait in the hold.
    const updates = commands.filter(isUpdate).length;
    await verify();
    expect(commands.filter(isUpdate)).toHaveLength(updates);
    expect(currentRule.Recipients).toEqual(["support@existing.invalid"]);
    // Nothing more to do while the reason stands.
    expect(await reconcile()).toEqual({ paused: 0, resumed: 0, failed: 0 });
    // An upgrade (or the next period) clears the reason: the same addresses come back.
    await db
      .update(schema.mailboxSubscriptions)
      .set({ inboundDeliveriesPerPeriod: 1000 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(await reconcile()).toEqual({ paused: 0, resumed: 1, failed: 0 });
    expect(currentRule.Recipients).toEqual([...addresses, "support@existing.invalid"].sort());
    expect(await holdRow()).toBeUndefined();
  });

  it("pauses only past the allowance plus its margin, and leaves the hold for a failed SES call", async () => {
    await verify();
    // 10 allowed, pause at 11 (10 * 1.1): 10 received keeps the hold unapplied and lifts it.
    await planOverAllowance(10);
    expect(await reconcile()).toEqual({ paused: 0, resumed: 1, failed: 0 });
    expect(await holdRow()).toBeUndefined();
    await db
      .update(schema.mailboxUsagePeriods)
      .set({ inboundDeliveries: 11 })
      .where(eq(schema.mailboxUsagePeriods.teamId, teamId));
    const sub = await subscriptionRow();
    await db
      .insert(schema.mailboxReceivingHolds)
      .values({ teamId, reason: "inbound_deliveries", periodEnd: sub.periodEnd });
    const working = client;
    client = { send: async () => Promise.reject(new Error("ses unavailable")) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await reconcile()).toEqual({ paused: 0, resumed: 0, failed: 1 });
    expect(await holdRow()).toMatchObject({ state: "pausing" });
    warn.mockRestore();
    client = working;
    expect(await reconcile()).toEqual({ paused: 1, resumed: 0, failed: 0 });
  });

  it("never empties a rule: its placeholder stays when the last address leaves", async () => {
    await verify();
    const addresses = [`first@${domainName}`, `second@${domainName}`];
    // The rule now holds only this team (another route left it meanwhile).
    currentRule.Recipients = [...addresses];
    await planOverAllowance(11);
    expect(await reconcile()).toEqual({ paused: 1, resumed: 0, failed: 0 });
    expect(currentRule.Recipients).toEqual(["reservado@regra-01.mepmail.invalid"]);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ inboundDeliveriesPerPeriod: 1000 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(await reconcile()).toEqual({ paused: 0, resumed: 1, failed: 0 });
    expect(currentRule.Recipients).toEqual(
      [...addresses, "reservado@regra-01.mepmail.invalid"].sort(),
    );
  });
});
