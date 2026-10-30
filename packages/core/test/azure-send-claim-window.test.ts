import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimAzureSend } from "../src/azure-send-claim.js";

let client: PGlite;
let db: Db;
let at: Date;
let deadline: Date;
let expireDuring: "none" | "update" | "quota" | "lifetime";

beforeEach(async () => {
  client = new PGlite();
  const root = process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT
    ? `${process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT}/drizzle/`
    : fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
  for (const name of readdirSync(root)
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(root + name, "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.exec(statement);
      }
    });
  }
  at = new Date();
  deadline = new Date(at.getTime() + 60_000);
  expireDuring = "none";
  db = drizzle(client, {
    schema,
    logger: {
      logQuery(query, params) {
        // Scheduling barrier only. Queries, writes and rollback use real PGlite.
        // The injectable application clock crosses the deadline during an awaited
        // operation; the real database clock remains inside its initial window.
        if (
          (expireDuring === "update" && /^update "emails"/.test(query)) ||
          (expireDuring === "quota" && params.includes("sending.azure_quota_reserved")) ||
          (expireDuring === "lifetime" && params.includes("sending.restoration_campaign_claimed"))
        ) {
          at = new Date(deadline);
        }
      },
    },
  }) as unknown as Db;
});

afterEach(async () => {
  await client.close();
});

async function specimen() {
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Window fixture", slug: randomUUID() })
    .returning();
  if (!team) throw new Error("fixture team missing");
  const createdAt = new Date(at.getTime() - 1_000);
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId: team.id,
      from: "fixture@example.invalid",
      to: ["recipient@example.invalid"],
      subject: "Synthetic window regression",
      createdAt,
    })
    .returning();
  if (!email) throw new Error("fixture email missing");
  return {
    email,
    input: {
      emailId: email.id,
      teamId: team.id,
      recipients: 1,
      now: () => new Date(at),
      campaignSnapshot: {
        createdAt: createdAt.toISOString(),
        from: email.from,
        to: email.to,
        sendWindow: {
          startsAt: new Date(at.getTime() - 60_000).toISOString(),
          endsAt: deadline.toISOString(),
        },
      },
    },
  };
}

describe("prospective Azure campaign claim expiry", () => {
  it.each(["update", "quota", "lifetime"] as const)(
    "rolls back only new writes when expiry occurs during %s",
    async (operation) => {
      const { email, input } = await specimen();
      expireDuring = operation;
      expect(await claimAzureSend(db, input)).toBe("skipped");
      const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
      expect(row?.sentAt).toBeNull();
      expect(await db.select().from(schema.auditLog)).toHaveLength(0);
    },
  );

  it("preserves a previously committed claim and both audits after expiry", async () => {
    const { email, input } = await specimen();
    expect(await claimAzureSend(db, input)).toBe("claimed");
    at = new Date(deadline);
    expect(await claimAzureSend(db, input)).toBe("skipped");
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
    expect(row?.sentAt).not.toBeNull();
    expect(await db.select().from(schema.auditLog)).toHaveLength(2);
  });
});
