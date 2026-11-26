import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { createTeam } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INCLUDED_SOLO_TERMS,
  lockMailboxService,
  MailboxServiceError,
  mailboxServiceEntitlement,
  mailboxServiceState,
  planIncludesCorreioSolo,
  reserveMailboxSeat,
} from "../src/index.js";

let client: PGlite;
let db: Db;
const now = new Date("2026-11-26T00:00:00Z");
const periodStart = new Date("2026-11-01T00:00:00Z");
const periodEnd = new Date("2026-12-01T00:00:00Z");

beforeAll(async () => {
  client = new PGlite();
  for (const folder of ["../../db/drizzle/", "../../db/mailbox-drizzle/"]) {
    const path = fileURLToPath(new URL(folder, import.meta.url));
    for (const name of readdirSync(path)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8").split("--> statement-breakpoint"))
          if (statement.trim()) await tx.exec(statement);
      });
  }
  db = drizzle(client, { schema }) as unknown as Db;
});

afterAll(async () => client?.close());

async function seedOwner(teamId: string): Promise<string> {
  const userId = randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    name: "Owner",
    email: `owner-${userId.slice(0, 8)}@example.invalid`,
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  return userId;
}

async function seedDomain(teamId: string): Promise<string> {
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `dom-${randomUUID().slice(0, 8)}.example.invalid`,
      region: "us-east-1",
      status: "verified",
      verifiedAt: now,
      lastCheckedAt: now,
      dmarcCheckedAt: now,
      mailFromSubdomain: "send",
      dkimSelector: "mepmail",
      dkimPublicKey: randomBytes(16).toString("hex"),
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("Domain fixture failed");
  return domain.id;
}

describe("Pro 110K+ included Correio Solo entitlement", () => {
  it("evaluates planIncludesCorreioSolo accurately across tiers and states", () => {
    expect(
      planIncludesCorreioSolo(
        { plan: "pro", planQuota: 110_000, planStatus: "active", currentPeriodEnd: periodEnd },
        now,
      ),
    ).toBe(true);
    expect(
      planIncludesCorreioSolo(
        { plan: "scale", planQuota: 550_000, planStatus: "active", currentPeriodEnd: periodEnd },
        now,
      ),
    ).toBe(true);
    expect(
      planIncludesCorreioSolo(
        { plan: "starter", planQuota: null, planStatus: "active", currentPeriodEnd: periodEnd },
        now,
      ),
    ).toBe(false);
    expect(
      planIncludesCorreioSolo(
        { plan: "free", planQuota: null, planStatus: "none", currentPeriodEnd: null },
        now,
      ),
    ).toBe(false);
    expect(
      planIncludesCorreioSolo(
        {
          plan: "pro",
          planQuota: 110_000,
          planStatus: "active",
          currentPeriodEnd: periodEnd,
          suspendedAt: now,
        },
        now,
      ),
    ).toBe(false);
    expect(
      planIncludesCorreioSolo(
        { plan: "pro", planQuota: 110_000, planStatus: "canceled", currentPeriodEnd: periodEnd },
        now,
      ),
    ).toBe(false);
  });

  it("grants 1 Solo mailbox seat to active Pro 110K subscribers, caps extra seats, and ends write entitlement on downgrade", async () => {
    const teamId = await createTeam(db, "pro-110k-included");
    const ownerId = await seedOwner(teamId);
    const domainId = await seedDomain(teamId);

    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 110_000,
        planStatus: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })
      .where(eq(schema.teams.id, teamId));

    const entitlement = await mailboxServiceEntitlement(db, teamId, false, now);
    expect(entitlement.active).toBe(true);
    expect(entitlement.includedWithSendPlan).toBe(true);
    expect(entitlement.licenseKind).toBe("subscription");
    expect(entitlement.plan).toMatchObject({
      planCode: INCLUDED_SOLO_TERMS.planCode,
      seats: 1,
      storageBytesPerMailbox: INCLUDED_SOLO_TERMS.storageBytesPerMailbox,
      includedOutboundPerMailbox: INCLUDED_SOLO_TERMS.includedOutboundPerMailbox,
      inboundDeliveriesPerPeriod: INCLUDED_SOLO_TERMS.inboundDeliveriesPerPeriod,
    });

    const state = await mailboxServiceState(db, teamId);
    expect(state.active).toBe(true);
    expect(state.includedWithSendPlan).toBe(true);
    expect(state.seats).toBe(1);

    const reserved = await reserveMailboxSeat(db, teamId);
    expect(reserved.active).toBe(true);
    const [box1] = await db
      .insert(schema.mailboxes)
      .values({
        teamId,
        domainId,
        ownerUserId: ownerId,
        address: `founder@example-${teamId.slice(0, 6)}.invalid`,
        label: "Founder",
        kind: "person",
        origin: "domain",
      })
      .returning({ id: schema.mailboxes.id });
    expect(box1?.id).toBeDefined();

    await expect(reserveMailboxSeat(db, teamId)).rejects.toThrowError(MailboxServiceError);

    // Downgrade to Starter ends included Solo entitlement cleanly while preserving stored mailboxes.
    await db
      .update(schema.teams)
      .set({ plan: "starter", planQuota: null, planStatus: "active" })
      .where(eq(schema.teams.id, teamId));

    const downgraded = await mailboxServiceEntitlement(db, teamId, false, now);
    expect(downgraded.active).toBe(false);
    expect(downgraded.resourcePolicyActive).toBe(false);
    expect(downgraded.includedWithSendPlan).toBe(false);
    await expect(lockMailboxService(db, teamId, now)).rejects.toThrowError(MailboxServiceError);

    const preservedBoxes = await db
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.teamId, teamId));
    expect(preservedBoxes).toHaveLength(1);
  });

  it("preserves explicit paid Duo/Equipe mailbox plans without overriding them with Solo", async () => {
    const teamId = await createTeam(db, "pro-plus-duo");
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 110_000,
        planStatus: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      stripeCustomerId: `cus_test_${teamId.slice(0, 8)}`,
      stripeSubscriptionId: `sub_test_${teamId.slice(0, 8)}`,
      stripePriceId: "price_duo",
      livemode: false,
      currency: "usd",
      unitAmount: 590,
      interval: "month",
      status: "active",
      seats: 3,
      includedMailboxes: 3,
      planCode: "duo",
      quotaScope: "team",
      storageBytesPerMailbox: 3 * 1024 ** 3,
      includedOutboundPerMailbox: 2000,
      inboundDeliveriesPerPeriod: 5000,
      inboundBytesPerPeriod: 1610612736,
      outboundBytesPerPeriod: 1073741824,
      periodStart,
      periodEnd,
    });

    const entitlement = await mailboxServiceEntitlement(db, teamId, false, now);
    expect(entitlement.active).toBe(true);
    expect(entitlement.includedWithSendPlan).toBe(false);
    expect(entitlement.plan?.seats).toBe(3);
    expect(entitlement.plan?.planCode).toBe("duo");
  });
});
