import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../db/drizzle");

/**
 * Fresh in-memory Postgres with the real generated migrations applied —
 * tests exercise the same DDL production runs, append-only trigger included.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  try {
    for (const file of files) {
      const statements = readFileSync(join(migrationsDir, file), "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // Match the production migrator: locks and DDL belong to one transaction.
      await client.transaction(async (migration) => {
        for (const statement of statements) await migration.exec(statement);
      });
    }
  } catch (error) {
    await client.close();
    throw error;
  }
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, close: () => client.close() };
}

export async function createTeam(db: Db, slug = "acme"): Promise<string> {
  const [team] = await db
    .insert(schema.teams)
    .values({ name: slug, slug })
    .returning({ id: schema.teams.id });
  if (!team) throw new Error("team insert failed");
  return team.id;
}

/**
 * Team columns for a verified monthly Send contract with verified Stripe
 * overage terms over one period: what a monthly plan needs before
 * overageEnabled can bill past the included volume (core teamQuota).
 */
export function verifiedMonthlyBilling(options: {
  teamId: string;
  periodStart: Date;
  periodEnd: Date;
  included: number;
  regularMonthlyCents?: number;
}): {
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeOverageItemId: string;
  sendBillingContract: schema.SendBillingContract;
  billingTerms: schema.BillingTerms;
} {
  const ids = {
    teamId: options.teamId,
    customerId: "cus_verified_fixture",
    subscriptionId: "sub_verified_fixture",
    baseItemId: "si_verified_base",
    basePriceId: "price_verified_base",
  };
  const start = options.periodStart.toISOString();
  const end = options.periodEnd.toISOString();
  const cents = options.regularMonthlyCents ?? 2_900;
  return {
    stripeCustomerId: ids.customerId,
    stripeSubscriptionId: ids.subscriptionId,
    stripeOverageItemId: "si_verified_meter",
    sendBillingContract: {
      version: 1,
      ...ids,
      currency: "usd",
      baseAmountCents: cents,
      billingInterval: "month",
      intervalCount: 1,
      included: options.included,
      usageInterval: "month",
      regularMonthlyCents: cents,
      financialPeriodStart: start,
      financialPeriodEnd: end,
      usageAnchor: start,
      verifiedAt: start,
    },
    billingTerms: {
      version: 1,
      ...ids,
      overageItemId: "si_verified_meter",
      overagePriceId: "price_verified_meter",
      currency: "usd",
      centsPerBlock: 130,
      blockSize: 1000,
      rounding: "up",
      included: options.included,
      periodStart: start,
      periodEnd: end,
      verifiedAt: start,
    },
  };
}

/**
 * An enabled webhook endpoint for fan-out tests. The secret columns hold a
 * placeholder byte: enqueueing reads only id, events, teamId and status.
 */
export async function createWebhookEndpoint(
  db: Db,
  teamId: string,
  events: string[] | null,
): Promise<string> {
  const dummy = Buffer.alloc(1);
  const [row] = await db
    .insert(schema.webhookEndpoints)
    .values({
      teamId,
      url: "https://hook.example.com/in",
      secretCiphertext: dummy,
      secretIv: dummy,
      secretWrappedDek: dummy,
      secretKeyVersion: 1,
      secretLast4: "abcd",
      events,
    })
    .returning({ id: schema.webhookEndpoints.id });
  if (!row) throw new Error("webhook endpoint insert failed");
  return row.id;
}
