import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  grantInternalMailboxLicense,
  revokeInternalMailboxLicense,
  type InternalMailboxGrant,
} from "../../../packages/core/src/mailbox-internal-license.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  importMailboxMime,
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import { mailboxServiceState } from "../../../packages/core/src/mailbox-service.js";
import {
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxTransportMime } from "../src/server/mailbox-transport";

let client: PGlite, db: Db, teamId: string, domainId: string, input: InternalMailboxGrant;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const actor = () => ({ teamId, userId: "owner" });
const grant = () => grantInternalMailboxLicense(db, "operator", input);
const plans = () =>
  db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
const audits = () => db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));
const revoke = (operationId: string) =>
  revokeInternalMailboxLicense(db, "operator", {
    teamId,
    grantId: input.grantId,
    operationId,
    reason: "End of local qualification",
  });
const box = (localPart: string, kind: "person" | "agent" = "person") =>
  createMailboxRegistry(db, actor(), {
    domainId,
    localPart,
    kind,
    label: localPart,
    ownerUserId: "owner",
  });
beforeEach(async () => {
  client = new PGlite();
  for (const file of readdirSync(base)
    .filter((n) => n.endsWith(".sql") && n.slice(0, 4) <= "0042")
    .sort())
    for (const statement of readFileSync(base + file, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await client.exec(statement);
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  await db.insert(schema.user).values([
    {
      id: "operator",
      name: "Operator",
      email: "operator@example.invalid",
      createdAt: new Date("2020-01-01"),
    },
    {
      id: "owner",
      name: "Owner",
      email: "owner@example.invalid",
      createdAt: new Date("2021-01-01"),
    },
  ]);
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Internal qualification", slug: "internal-qualification", plan: "pro" })
    .returning();
  teamId = team!.id;
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "pilot.example.invalid", region: "us-east-1", status: "verified" })
    .returning();
  domainId = domain!.id;
  input = {
    grantId: randomUUID(),
    teamId,
    ownerUserId: "owner",
    reason: "Local pilot qualification",
    terms: {
      seats: 2,
      storageBytesPerMailbox: 2 * 1024 * 1024,
      includedOutboundPerMailbox: 3,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 30 * 86400000),
    },
  };
});
afterEach(async () => {
  await client.close();
});

describe("audited operator-only two-mailbox internal licence", () => {
  it("snapshots allowed fields before waiting and ignores injected provider terms", async () => {
    const grantId = input.grantId;
    const originalStart = new Date(input.terms.periodStart);
    const originalEnd = new Date(input.terms.periodEnd);
    Object.assign(input.terms, { stripeSubscriptionId: "sub_injected", status: "canceled" });
    const pending = grant();
    input.grantId = randomUUID();
    input.teamId = randomUUID();
    input.ownerUserId = "other";
    input.reason = "Changed after the call";
    input.terms.seats = 1 as unknown as 2;
    input.terms.storageBytesPerMailbox = 1;
    input.terms.includedOutboundPerMailbox = 0;
    input.terms.periodStart.setTime(0);
    input.terms.periodEnd.setTime(1);
    expect(await pending).toMatchObject({ applied: true, grantId, teamId });
    expect((await plans())[0]).toMatchObject({
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 2 * 1024 * 1024,
      includedOutboundPerMailbox: 3,
      periodStart: originalStart,
      periodEnd: originalEnd,
      stripeSubscriptionId: null,
    });
    expect((await audits())[0]).toMatchObject({
      id: grantId,
      data: {
        ownerUserId: "owner",
        reason: "Local pilot qualification",
        terms: {
          seats: 2,
          periodStart: originalStart.toISOString(),
          periodEnd: originalEnd.toISOString(),
        },
      },
    });
  });
  it("grants two equal person/agent seats with mandatory provenance and no Send change", async () => {
    expect(await grant()).toMatchObject({ applied: true, grantId: input.grantId });
    await box("person");
    await box("agent", "agent");
    await expect(box("third")).rejects.toMatchObject({ code: "quota" });
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      active: true,
      seats: 2,
      reservedSeats: 2,
    });
    expect((await plans())[0]).toMatchObject({
      status: "active",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      stripePriceId: null,
      currency: null,
      unitAmount: null,
    });
    expect((await audits())[0]).toMatchObject({
      id: input.grantId,
      actorId: "user:operator",
      action: "mailbox.license_granted",
      data: { format: "internal-mailbox-license-v1", ownerUserId: "owner" },
    });
    expect((await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]!.plan).toBe(
      "pro",
    );
  });
  it("makes exact retries a noop and rejects changed terms or another grant", async () => {
    await grant();
    expect(await grant()).toMatchObject({ applied: false });
    expect(await audits()).toHaveLength(1);
    await expect(
      grantInternalMailboxLicense(db, "operator", {
        ...input,
        terms: { ...input.terms, includedOutboundPerMailbox: 99 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      grantInternalMailboxLicense(db, "operator", { ...input, grantId: randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await plans())[0]!.includedOutboundPerMailbox).toBe(3);
  });
  it("rechecks instance operator and current owner membership instead of trusting request roles", async () => {
    await expect(grantInternalMailboxLicense(db, "owner", input)).rejects.toMatchObject({
      code: "forbidden",
    });
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await expect(grant()).rejects.toMatchObject({ code: "forbidden" });
    expect(await plans()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });
  it("pins a retry to the original membership and never reactivates a revoked grant", async () => {
    await grant();
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await expect(grant()).rejects.toMatchObject({ code: "conflict" });
    await revoke(randomUUID());
    await expect(grant()).rejects.toMatchObject({ code: "conflict" });
  });
  it.each(["customer", "checkout"])("preserves a pre-existing %s provider intent", async (kind) => {
    if (kind === "customer")
      await db.insert(schema.mailboxCustomerRequests).values({
        teamId,
        createdBy: "owner",
        name: "Owner",
        email: "owner@example.invalid",
        livemode: false,
        idempotencyKey: "local-customer",
      });
    else
      await db.insert(schema.mailboxCheckouts).values({
        teamId,
        createdBy: "owner",
        stripeCustomerId: "cus_local",
        stripePriceId: "price_local",
        seats: 2,
        livemode: false,
        idempotencyKey: "local-checkout",
        currency: "usd",
        unitAmount: 100,
        interval: "month",
        storageBytesPerMailbox: 10000,
        includedOutboundPerMailbox: 3,
        successUrl: "https://example.invalid/success",
        cancelUrl: "https://example.invalid/cancel",
      });
    await expect(grant()).rejects.toMatchObject({ code: "conflict" });
    expect(await plans()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });
  it.each(["mailbox.license_granted", "mailbox.license_revoked"])(
    "rolls back when required %s audit persistence fails",
    async (action) => {
      if (action.endsWith("revoked")) await grant();
      await client.exec(
        `CREATE FUNCTION reject_internal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'local audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_internal_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_internal_audit();`,
      );
      if (action.endsWith("granted")) {
        await expect(grant()).rejects.toThrow();
        expect(await plans()).toHaveLength(0);
        expect(await audits()).toHaveLength(0);
      } else {
        await expect(revoke(randomUUID())).rejects.toThrow();
        expect((await plans())[0]!.status).toBe("active");
        expect(await audits()).toHaveLength(1);
      }
    },
  );
  it("revokes idempotently while preserving encrypted mail, both boxes and unknown sends without replay", async () => {
    await grant();
    const person = await box("person"),
      agent = await box("agent", "agent");
    const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
    const raw = Buffer.from(
      `From: ${person.address}\r\nTo: recipient@example.invalid\r\nSubject: Local recovery\r\nMessage-ID: <${randomUUID()}@example.invalid>\r\n\r\nPreserve me.`,
    );
    const inbox = await importMailboxMime(db, keys, actor(), {
      mailboxId: person.id,
      sourceId: "internal-test-inbox",
      raw,
    });
    const draft = await saveMailboxDraft(db, keys, actor(), {
      mailboxId: person.id,
      expectedRevision: 0,
      raw,
    });
    const outbox = await queueMailboxDraft(
      db,
      keys,
      actor(),
      { mailboxId: person.id, id: draft.id, expectedRevision: 1 },
      mailboxTransportMime,
    );
    expect(
      (
        await sendMailboxOutbox(
          db,
          keys,
          outbox.id,
          {
            async send() {
              throw new Error("local ambiguous provider result");
            },
          },
          mailboxTransportMime,
        )
      ).status,
    ).toBe("unknown");
    const before = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.id, outbox.id));
    const operationId = randomUUID();
    expect(await revoke(operationId)).toMatchObject({ applied: true });
    expect(await revoke(operationId)).toMatchObject({ applied: false });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: person.id, id: inbox.id })).raw.equals(
        raw,
      ),
    ).toBe(true);
    expect(
      await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, outbox.id)),
    ).toEqual(before);
    expect(
      (await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.teamId, teamId)))
        .map((b) => b.id)
        .sort(),
    ).toEqual([person.id, agent.id].sort());
    let senderCalls = 0;
    expect(
      (
        await sendMailboxOutbox(
          db,
          keys,
          outbox.id,
          {
            async send() {
              senderCalls++;
              throw new Error("must not replay");
            },
          },
          mailboxTransportMime,
        )
      ).status,
    ).toBe("unknown");
    expect(senderCalls).toBe(0);
    expect(await audits()).toHaveLength(2);
    await expect(box("after-revoke")).rejects.toMatchObject({ code: "not_entitled" });
  });
  it("rejects revocation of a plan whose audited fingerprint was changed", async () => {
    await grant();
    await db
      .update(schema.mailboxSubscriptions)
      .set({ seats: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(revoke(randomUUID())).rejects.toMatchObject({ code: "conflict" });
    expect((await plans())[0]!.status).toBe("active");
    expect(await audits()).toHaveLength(1);
  });
  it("requires explicit two-seat bounds and a currently usable period", async () => {
    await expect(
      grantInternalMailboxLicense(db, "operator", {
        ...input,
        terms: { ...input.terms, seats: 1 } as unknown as InternalMailboxGrant["terms"],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      grantInternalMailboxLicense(db, "operator", {
        ...input,
        terms: {
          ...input.terms,
          periodStart: new Date(Date.now() - 20000),
          periodEnd: new Date(Date.now() - 10000),
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await plans()).toHaveLength(0);
  });
});
