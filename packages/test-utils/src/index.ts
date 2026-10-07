import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../db/drizzle");
const SNAPSHOT_PREFIX = "mepmail-test-db-";

function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function migrate(client: PGlite, files: string[]): Promise<void> {
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
}

/** The installed PGlite version (a data-dir dump is only valid for the version that wrote it). */
function pgliteVersion(): string {
  // The package exports no ./package.json, so walk up from its entry point.
  let dir = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest.name === "@electric-sql/pglite") return String(manifest.version);
    } catch {
      // Not the package root yet.
    }
    dir = dirname(dir);
  }
  throw new Error("Cannot read the installed @electric-sql/pglite version");
}

/**
 * The migrated, still-empty database as a PGlite data-dir dump, shared by every
 * test process through the OS temp dir. Its name hashes every migration and the
 * PGlite version, so a changed or added migration builds a new one; restoring
 * it (~0.35 s) replaces replaying all migrations (~1-2 s) for each database.
 */
async function migratedTemplate(): Promise<Blob> {
  const files = migrationFiles();
  const hash = createHash("sha256");
  hash.update(pgliteVersion());
  for (const file of files) hash.update(file).update(readFileSync(join(migrationsDir, file)));
  const name = `${SNAPSHOT_PREFIX}${hash.digest("hex").slice(0, 24)}.tar`;
  const path = join(tmpdir(), name);
  try {
    return new Blob([readFileSync(path)]);
  } catch {
    // Not built yet for this migration set.
  }
  const client = new PGlite();
  try {
    await migrate(client, files);
    const dump = await client.dumpDataDir("none");
    // Write-then-rename: concurrent test workers never read a half-written file.
    const partial = `${path}.${randomUUID()}`;
    writeFileSync(partial, Buffer.from(await dump.arrayBuffer()));
    renameSync(partial, path);
    for (const old of readdirSync(tmpdir())) {
      if (old.startsWith(SNAPSHOT_PREFIX) && old !== name && old.endsWith(".tar")) {
        rmSync(join(tmpdir(), old), { force: true });
      }
    }
    return dump;
  } finally {
    await client.close();
  }
}

let template: Promise<Blob> | undefined;

/**
 * Fresh in-memory Postgres with the real generated migrations applied —
 * tests exercise the same DDL production runs, append-only trigger included.
 * Each call is its own database, restored from the migrated template;
 * MEPMAIL_TEST_DB_FRESH=1 replays the migrations every time instead.
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  let client: PGlite;
  if (process.env.MEPMAIL_TEST_DB_FRESH === "1") {
    client = new PGlite();
    try {
      await migrate(client, migrationFiles());
    } catch (error) {
      await client.close();
      throw error;
    }
  } else {
    template ??= migratedTemplate().catch((error) => {
      template = undefined;
      throw error;
    });
    client = new PGlite({ loadDataDir: await template });
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
