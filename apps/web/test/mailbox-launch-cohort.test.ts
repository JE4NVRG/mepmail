import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMailboxAgentKey, withMailboxAgentAccess } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxBillingPresentation } from "@/server/mailbox-billing";
import { mailboxActorAccessEnabled, mailboxCreateAccessEnabled } from "@/server/mailboxes";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import type { MailboxLaunchCohort } from "../../../packages/core/src/mailbox-launch-cohort";
import type { SendBillingContract } from "../../../packages/core/src/send-billing-contract";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@millionsend/config", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_offline_cohort_only",
    APP_BASE_URL: "https://example.invalid",
  },
  isCloudDeployment: () => true,
}));
vi.mock("@/server/billing", () => ({ getStripe: vi.fn() }));
// Caller contexts are supplied directly; no framework cookie/header request is made.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (url: string) => url }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: vi.fn(),
  getMailboxContentList: vi.fn(),
  saveMailboxContentDraft: vi.fn(),
}));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: {} }));
vi.mock("@/server/mailbox-receiving", () => ({ mailboxReceivingDeps: vi.fn() }));
vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/queue", () => ({ getQueue: vi.fn() }));

// Real current Main/Mail migrations and router/Core admission; only unrelated
// transport/provider seams are mocked. Every identity and price is synthetic.
let db: Db, close: () => Promise<void>, teamId: string, otherTeam: string, domainId: string;
let cohort: MailboxLaunchCohort, contract: SendBillingContract;
let sequence = 0;
const owner = "cohort_fixture_owner",
  outsider = "cohort_fixture_outsider";
const start = new Date("2020-01-01"),
  end = new Date("2030-01-01");
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const actor = () => ({ teamId, userId: owner });
const as = (userId = owner) =>
  caller({
    db,
    teamId,
    role: "owner",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  } satisfies Context).mailboxes;
const configure = (value: MailboxLaunchCohort = cohort) =>
  vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", JSON.stringify(value));
const update = (values: Partial<typeof schema.teams.$inferInsert>) =>
  db.update(schema.teams).set(values).where(eq(schema.teams.id, teamId));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.execute(sql.raw(statement));
  await db.insert(schema.user).values([
    {
      id: owner,
      name: owner,
      email: `${owner}@example.invalid`,
      createdAt: new Date("2000-01-01"),
    },
    {
      id: outsider,
      name: outsider,
      email: `${outsider}@example.invalid`,
      createdAt: new Date("2001-01-01"),
    },
  ]);
});
afterAll(async () => close());
beforeEach(async () => {
  sequence++;
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  vi.stubEnv("MAILBOX_BILLING_PAUSED", "false");
  vi.stubEnv("BILLING_MUTATIONS_PAUSED", "false");
  vi.stubEnv(
    "MAILBOX_BILLING_CATALOG",
    JSON.stringify({
      livemode: false,
      checkoutPriceId: "price_cohort_fixture",
      prices: [
        {
          priceId: "price_cohort_fixture",
          currency: "usd",
          unitAmount: 590,
          interval: "month",
          storageBytesPerMailbox: 1024 ** 3,
          includedOutboundPerMailbox: 500,
        },
      ],
    }),
  );
  teamId = await createTeam(db, `cohort-fixture-${sequence}`);
  otherTeam = await createTeam(db, `cohort-other-${sequence}`);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: owner, role: "owner" },
    { teamId: otherTeam, userId: outsider, role: "owner" },
  ]);
  contract = {
    version: 1,
    teamId,
    customerId: `cus_cohort_${sequence}`,
    subscriptionId: `sub_cohort_${sequence}`,
    baseItemId: `si_cohort_${sequence}`,
    basePriceId: "price_verified_legacy",
    currency: "usd",
    baseAmountCents: 10_000,
    billingInterval: "month",
    intervalCount: 1,
    included: 220_000,
    usageInterval: "month",
    regularMonthlyCents: 10_000,
    financialPeriodStart: start.toISOString(),
    financialPeriodEnd: end.toISOString(),
    usageAnchor: start.toISOString(),
    verifiedAt: new Date().toISOString(),
  };
  await update({
    plan: "pro",
    planStatus: "active",
    stripeCustomerId: contract.customerId,
    stripeSubscriptionId: contract.subscriptionId,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    sendBillingContract: contract,
  });
  cohort = {
    version: 1,
    capturedAt: "2020-01-02T00:00:00.000Z",
    members: [
      {
        teamId,
        customerId: contract.customerId,
        subscriptionId: contract.subscriptionId,
      },
    ],
  };
  configure();
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `cohort-${sequence}.example.invalid`,
      region: "us-east-1",
      status: "verified",
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("Missing cohort fixture domain");
  domainId = domain.id;
});
afterEach(() => vi.unstubAllEnvs());

describe("Correio hosted opening admission", () => {
  it("exposes only the enrolled member and a verified paid add-on purchase", async () => {
    expect(await as().capabilities()).toEqual({ enabled: true, deliveryReady: false });
    expect(await as().billing()).toMatchObject({ canPurchase: true, earlyAccessRequired: false });
    expect(await mailboxActorAccessEnabled(db, { teamId, userId: outsider })).toBe(false);
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(true);
  });
  it("admits a new US29 buyer who is not on the captured list of grants", async () => {
    configure({ ...cohort, members: [] });
    await update({
      sendBillingContract: { ...contract, baseAmountCents: 2900, regularMonthlyCents: 2900 },
    });
    expect(await as().capabilities()).toEqual({ enabled: true, deliveryReady: false });
    expect(await mailboxBillingPresentation(db, actor())).toMatchObject({
      canPurchase: true,
      sendingPlanRequired: false,
      earlyAccessRequired: false,
      availability: "available",
    });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(true);
  });
  it("keeps a team that never paid for Envio out of the purchase", async () => {
    configure({ ...cohort, members: [] });
    await update({
      plan: "free",
      planStatus: "none",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      sendBillingContract: null,
    });
    expect(await as().capabilities()).toEqual({ enabled: false, deliveryReady: false });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(false);
  });
  it("does not grant an ordinary US20 contract a default exception", async () => {
    await update({
      sendBillingContract: { ...contract, baseAmountCents: 2000, regularMonthlyCents: 2000 },
    });
    expect(await as().billing()).toMatchObject({ canPurchase: false, sendingPlanRequired: true });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(false);
  });
  it("can honor a separately configured original-US20 exception without changing price", async () => {
    const twenty = { ...contract, baseAmountCents: 2000, regularMonthlyCents: 2000 };
    await update({ sendBillingContract: twenty });
    configure({
      ...cohort,
      members: cohort.members.map((m) => ({ ...m, grandfatheredTwentyDollarPlan: true })),
    });
    expect(await as().billing()).toMatchObject({ canPurchase: true, sendingPlanRequired: false });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(true);
    const [persisted] = await db
      .select({ contract: schema.teams.sendBillingContract })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    expect(persisted?.contract).toEqual(twenty);
  });
  it("rechecks current signed status and bindings even for enrolled teams", async () => {
    await update({ planStatus: "past_due" });
    expect(await as().billing()).toMatchObject({ canPurchase: false, sendingPlanRequired: true });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(false);
    await update({ planStatus: "active", stripeCustomerId: "cus_foreign" });
    // Admission only needs a customer; the signed contract must still match it to buy or create.
    expect(await mailboxActorAccessEnabled(db, actor())).toBe(true);
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(false);
  });
  it("keeps existing content and contract management visible after Envio expiry/outside cohort", async () => {
    await seedMailboxTestService(db, [teamId]);
    configure({ ...cohort, members: [] });
    await update({ planStatus: "canceled" });
    expect(await as().capabilities()).toEqual({ enabled: true, deliveryReady: false });
    expect(await as().list()).toMatchObject({ mailboxes: [] });
    expect(await as().billing()).toMatchObject({
      availability: "existing_subscription",
      canPurchase: false,
    });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(false);
  });
  it("requires paid mailbox seats after eligibility and never turns a reservation into receiving", async () => {
    const create = (localPart: string) =>
      as().create({ domainId, localPart, label: localPart, kind: "agent", ownerUserId: owner });
    await expect(create("first")).rejects.toMatchObject({ message: "not_entitled" });
    await seedMailboxTestService(db, [teamId]);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ seats: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(await create("first")).toHaveProperty("id");
    await expect(create("second")).rejects.toMatchObject({ message: "quota" });
    const rows = await as().list();
    expect(rows.mailboxes).toHaveLength(1);
    expect(rows.mailboxes[0]?.status).toBe("planned");
    expect(await as().capabilities()).toMatchObject({ deliveryReady: false });
  });
  it("preserves verified System unlimited seats/outbound and 50GiB even with invalid cohort", async () => {
    await update({ plan: "system", sendBillingContract: null, planStatus: "canceled" });
    await seedMailboxTestService(db, [teamId]);
    vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", "invalid");
    expect(await as().capabilities()).toEqual({ enabled: true, deliveryReady: false });
    expect(await as().service()).toMatchObject({
      licenseKind: "system",
      unlimitedSeats: true,
      unlimitedOutbound: true,
      storageBytesPerMailbox: 50 * 1024 ** 3,
    });
    expect(await mailboxCreateAccessEnabled(db, actor())).toBe(true);
    expect(await mailboxActorAccessEnabled(db, { teamId, userId: outsider })).toBe(false);
    const box = await as().create({
      domainId,
      localPart: "system-agent",
      label: "System agent",
      kind: "agent",
      ownerUserId: owner,
    });
    const key = await createMailboxAgentKey(db, actor(), {
      mailboxId: box.id,
      label: "Offline System proof",
      scopes: ["read", "draft"],
    });
    for (const scope of ["read", "draft"] as const) {
      const authorized = await withMailboxAgentAccess(db, key.token, scope, async (context) => ({
        mailboxId: context.mailboxId,
        actor: context.actor,
        admitted: await mailboxActorAccessEnabled(context.db, context.actor),
      }));
      expect(authorized).toEqual({
        mailboxId: box.id,
        actor: { ...actor(), agentAccess: true },
        admitted: true,
      });
    }
  });
  it("fails closed for invalid present configuration and preserves absent legacy behavior", async () => {
    vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", "{}");
    expect(await as().capabilities()).toEqual({ enabled: false, deliveryReady: false });
    vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", undefined);
    expect(await as().capabilities()).toEqual({ enabled: true, deliveryReady: false });
  });
});
