import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifySenderDomain } from "../../../packages/core/src/accept-email.js";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import { addMailboxAlias } from "../../../packages/core/src/mailbox-aliases.js";
import {
  mailboxHoldReason,
  mailboxInboundPauseAt,
  mailboxPlanUsage,
} from "../../../packages/core/src/mailbox-plan-usage.js";
import {
  listMailboxThread,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxItemTrash,
} from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  MAILBOX_TRIAL_GLOBAL_DAILY_RECIPIENTS,
  mailboxTrialGlobalToday,
} from "../../../packages/core/src/mailbox-service.js";
import {
  failQueuedMailboxOutbox,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  receiveMailboxMime,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";

// Correio plans meter the whole team: one inbound delivery per provider receipt, shared
// storage, shared outbound recipients and MIME bytes. Real Main/Mail migrations on PGlite.
let client: PGlite,
  db: Db,
  teamId: string,
  foreignTeamId: string,
  mailboxId: string,
  agentId: string,
  foreignId: string,
  keys: Keyring;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const owner = () => ({ teamId, userId: "owner" });
const mimeAdapter: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const list = (v: typeof parsed.to) =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .flatMap((entry) => entry.value)
        .map((entry) => entry.address!)
        .filter(Boolean);
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: list(parsed.to),
      cc: list(parsed.cc),
      bcc: list(parsed.bcc),
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
const fixture = (from = "person@plans.invalid", to = "someone@example.invalid", body = "plan") =>
  Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: Plan fixture\r\nMessage-ID: <plan@plans.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`,
  );
const inbound = fixture("external@example.invalid", "person@plans.invalid", "inbound body");
const receive = (sourceId: string, recipients = ["person@plans.invalid"], raw = inbound) =>
  receiveMailboxMime(db, keys, { sourceId, recipients, raw }, mimeAdapter);
const draft = (raw = fixture(), box = mailboxId) =>
  saveMailboxDraft(db, keys, owner(), { mailboxId: box, expectedRevision: 0, raw });
const queue = (id: string, box = mailboxId) =>
  queueMailboxDraft(db, keys, owner(), { mailboxId: box, id, expectedRevision: 1 }, mimeAdapter);
const subscription = async (team = teamId) =>
  (
    await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, team))
  )[0]!;
const setPlan = (values: Partial<typeof schema.mailboxSubscriptions.$inferInsert>, team = teamId) =>
  db
    .update(schema.mailboxSubscriptions)
    .set(values)
    .where(eq(schema.mailboxSubscriptions.teamId, team));
const usage = async () => mailboxPlanUsage(db, teamId, (await subscription()).periodStart);
const holds = () => db.select().from(schema.mailboxReceivingHolds);

beforeEach(async () => {
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema: { ...schema, mailboxOutbox } });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Plans", slug: "plans" },
      { name: "Legacy", slug: "plans-legacy" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  for (const id of ["owner", "foreign"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const now = Date.now();
  const period = { periodStart: new Date(now - 86400000), periodEnd: new Date(now + 86400000) };
  // A Duo plan (3 mailboxes, team-wide allowances), next to a legacy per-mailbox license.
  await db.insert(schema.mailboxSubscriptions).values([
    {
      teamId,
      status: "active" as const,
      seats: 3,
      includedMailboxes: 3,
      quotaScope: "team" as const,
      planCode: "duo",
      storageBytesPerMailbox: 8 * 1024 * 1024,
      includedOutboundPerMailbox: 6,
      inboundDeliveriesPerPeriod: 10,
      inboundBytesPerPeriod: 1024 * 1024,
      outboundBytesPerPeriod: 1024 * 1024,
      ...period,
    },
    {
      teamId: foreignTeamId,
      status: "active" as const,
      seats: 5,
      storageBytesPerMailbox: 8 * 1024 * 1024,
      includedOutboundPerMailbox: 10,
      ...period,
    },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "plans.invalid", status: "verified", region: "us-east-1" },
      { teamId: foreignTeamId, name: "legacy.invalid", status: "verified", region: "us-east-1" },
    ])
    .returning();
  const box = (localPart: string, kind: "person" | "agent") =>
    createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart,
      label: localPart,
      kind,
      ownerUserId: "owner",
    });
  mailboxId = (await box("person", "person")).id;
  agentId = (await box("agent", "agent")).id;
  foreignId = (
    await createMailboxRegistry(
      db,
      { teamId: foreignTeamId, userId: "foreign" },
      {
        domainId: domains[1]!.id,
        localPart: "other",
        label: "Other",
        kind: "person",
        ownerUserId: "foreign",
      },
    )
  ).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("Correio plan inbound metering", () => {
  it("counts one delivery per receipt and team across fanout, aliases, redelivery and deletion", async () => {
    await addMailboxAlias(db, owner(), { mailboxId, localPart: "support" });
    // One receipt to two mailboxes and an alias of one of them: one delivery, its bytes once.
    const first = await receive("receipt:1", [
      "person@plans.invalid",
      "agent@plans.invalid",
      "support@plans.invalid",
    ]);
    expect(first.items.map((i) => i.mailboxId).sort()).toEqual([mailboxId, agentId].sort());
    expect(await usage()).toMatchObject({ inboundDeliveries: 1, inboundBytes: inbound.length });
    // The provider redelivering the same receipt stores and counts nothing more.
    const again = await receive("receipt:1", ["support@plans.invalid", "agent@plans.invalid"]);
    expect(again.items.every((i) => i.duplicate)).toBe(true);
    expect(await usage()).toMatchObject({ inboundDeliveries: 1, inboundBytes: inbound.length });
    // Deleting mail frees nothing of the period's allowance.
    const item = first.items.find((i) => i.mailboxId === mailboxId)!;
    await setMailboxItemTrash(db, owner(), {
      mailboxId,
      id: item.id,
      expectedRevision: 1,
      trashed: true,
    });
    await receive("receipt:2");
    expect(await usage()).toMatchObject({ inboundDeliveries: 2, inboundBytes: inbound.length * 2 });
    // A receipt shared with a legacy team meters only the plan team.
    await receive("receipt:3", ["person@plans.invalid", "other@legacy.invalid"]);
    expect(await usage()).toMatchObject({ inboundDeliveries: 3 });
    expect(
      await db
        .select()
        .from(schema.mailboxUsagePeriods)
        .where(eq(schema.mailboxUsagePeriods.teamId, foreignTeamId)),
    ).toEqual([]);
    expect(await holds()).toEqual([]);
  });

  it("asks for a receiving pause past the allowance plus 10%, and still stores what SES accepted", async () => {
    await setPlan({ inboundDeliveriesPerPeriod: 2 });
    expect(mailboxInboundPauseAt(2)).toBe(3);
    expect((await receive("abuse:1")).holds).toEqual([]);
    expect((await receive("abuse:2")).holds).toEqual([]);
    expect((await receive("abuse:3")).holds).toEqual([teamId]);
    expect(await holds()).toMatchObject([
      { teamId, reason: "inbound_deliveries", state: "pausing", recipients: [] },
    ]);
    // Mail in flight before SES applies the pause is kept, never silently dropped.
    const late = await receive("abuse:4");
    expect(late.holds).toEqual([]);
    expect(late.items[0]!.duplicate).toBe(false);
    expect(await usage()).toMatchObject({ inboundDeliveries: 4 });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(4);
  });

  it("pauses on inbound bytes when a few large messages exceed the byte allowance", async () => {
    const large = fixture("external@example.invalid", "person@plans.invalid", "x".repeat(4000));
    await setPlan({ inboundBytesPerPeriod: large.length });
    expect((await receive("large:1", undefined, large)).holds).toEqual([]);
    expect((await receive("large:2", undefined, large)).holds).toEqual([teamId]);
    expect(await holds()).toMatchObject([{ reason: "inbound_bytes" }]);
  });

  it("keeps reading and exporting with storage full, refuses new outbound copies, and pauses receiving", async () => {
    await setPlan({ storageBytesPerMailbox: inbound.length + 10 });
    const kept = await receive("full:1");
    // Over the shared storage: SES already accepted it, so it is stored and receiving pauses.
    const over = await receive("full:2");
    expect(over.items[0]!.duplicate).toBe(false);
    expect(over.holds).toEqual([teamId]);
    expect(await holds()).toMatchObject([{ reason: "storage" }]);
    const plan = await subscription();
    expect(mailboxHoldReason(plan, await mailboxPlanUsage(db, teamId, plan.periodStart))).toBe(
      "storage",
    );
    // Every stored message stays readable (and so exportable, raw MIME included).
    for (const item of [...kept.items, ...over.items]) {
      const read = await readMailboxItem(db, keys, owner(), { mailboxId, id: item.id });
      expect(read.raw.equals(inbound)).toBe(true);
    }
    expect(await listMailboxThread(db, owner(), { mailboxId, id: kept.items[0]!.id })).toBeTruthy();
    // Nothing new is written while full: a draft (stored) or outbound copy would add bytes.
    await expect(draft()).rejects.toMatchObject({ code: "quota" });
    // Legacy per-mailbox terms keep refusing inbound past storage, as they always did.
    await setPlan({ storageBytesPerMailbox: 1 }, foreignTeamId);
    await expect(receive("legacy:1", ["other@legacy.invalid"])).rejects.toMatchObject({
      code: "quota",
    });
  });
});

describe("Correio plan outbound allowances", () => {
  it("shares the recipient allowance across the team's mailboxes", async () => {
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}@example.invalid`).join(", ");
    expect((await queue((await draft(fixture(undefined, many(4, "a")))).id)).recipientCount).toBe(
      4,
    );
    // 4 of 6 used by person@: agent@ can send 2 more, not 3.
    const agentDraft = async (n: number) =>
      (await draft(fixture("agent@plans.invalid", many(n, `b${n}-`)), agentId)).id;
    await expect(queue(await agentDraft(3), agentId)).rejects.toMatchObject({ code: "quota" });
    expect((await queue(await agentDraft(2), agentId)).recipientCount).toBe(2);
    await expect(
      queue((await draft(fixture(undefined, "last@example.invalid"))).id),
    ).rejects.toMatchObject({ code: "quota" });
    expect(await usage()).toMatchObject({ outboundRecipients: 6 });
  });

  it("caps MIME bytes × recipients, and a failed admission gives its share back", async () => {
    const raw = fixture(undefined, "one@example.invalid, two@example.invalid");
    await setPlan({ outboundBytesPerPeriod: raw.length * 3 });
    const sent = await queue((await draft(raw)).id);
    expect(await usage()).toMatchObject({ outboundBytes: raw.length * 2, outboundRecipients: 2 });
    // Two more copies would be 4 × size: over the 3 × size allowance.
    const next = await draft(raw);
    await expect(queue(next.id)).rejects.toMatchObject({ code: "quota" });
    // A queued message that never left fails and stops counting.
    expect(await failQueuedMailboxOutbox(db, sent.id)).toBe(true);
    expect(await usage()).toMatchObject({ outboundBytes: 0, outboundRecipients: 0 });
    expect((await queue(next.id)).recipientCount).toBe(2);
  });

  it("never admits past the allowance when admissions race", async () => {
    await setPlan({ includedOutboundPerMailbox: 3 });
    const ids = [];
    for (let i = 0; i < 6; i++)
      ids.push((await draft(fixture(undefined, `race${i}@example.invalid`))).id);
    const results = await Promise.allSettled(ids.map((id) => queue(id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .every((r) => (r.reason as { code?: string }).code === "quota"),
    ).toBe(true);
    expect(await usage()).toMatchObject({ outboundRecipients: 3 });
  });
});

describe("Correio trials", () => {
  it("stops every trial together at the global daily ceiling", async () => {
    await setPlan({ status: "trialing" });
    await setPlan({ status: "trialing" }, foreignTeamId);
    // Another trialing team already queued all but one recipient of today's global budget.
    const foreignDraft = await saveMailboxDraft(
      db,
      keys,
      { teamId: foreignTeamId, userId: "foreign" },
      { mailboxId: foreignId, expectedRevision: 0, raw: fixture("other@legacy.invalid") },
    );
    const queued = await queueMailboxDraft(
      db,
      keys,
      { teamId: foreignTeamId, userId: "foreign" },
      { mailboxId: foreignId, id: foreignDraft.id, expectedRevision: 1 },
      mimeAdapter,
    );
    const [row] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, queued.id));
    let left = MAILBOX_TRIAL_GLOBAL_DAILY_RECIPIENTS - 2;
    for (let revision = 2; left > 0; revision++) {
      const count = Math.min(20, left);
      await db.insert(mailboxOutbox).values({
        ...row!,
        id: randomUUID(),
        draftRevision: revision,
        recipientCount: count,
        recipientHashes: null,
      });
      left -= count;
    }
    expect(await mailboxTrialGlobalToday(db)).toBe(MAILBOX_TRIAL_GLOBAL_DAILY_RECIPIENTS - 1);
    // One recipient fits; two do not, though this team's own trial allowance has room.
    await expect(
      queue((await draft(fixture(undefined, "a@example.invalid, b@example.invalid"))).id),
    ).rejects.toMatchObject({ code: "trial_limit" });
    expect((await queue((await draft()).id)).recipientCount).toBe(1);
    await expect(queue((await draft()).id)).rejects.toMatchObject({ code: "trial_limit" });
    // Paying ends the trial: the global trial budget no longer applies.
    await setPlan({ status: "active" });
    expect((await queue((await draft()).id)).recipientCount).toBe(1);
  });
});

describe("Envio is not a second way out for Correio addresses", () => {
  it("refuses a mailbox or alias sender on a free Envio plan and allows it once Envio is paid", async () => {
    await addMailboxAlias(db, owner(), { mailboxId, localPart: "vendas" });
    for (const from of ["Person <person@plans.invalid>", "vendas@plans.invalid"])
      expect(await verifySenderDomain(db, teamId, from)).toEqual({
        ok: false,
        reason: "mailbox_sender",
        fromDomain: "plans.invalid",
      });
    // Other addresses of the verified domain keep Envio's free tier.
    expect(await verifySenderDomain(db, teamId, "news@plans.invalid")).toMatchObject({ ok: true });
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
    expect(await verifySenderDomain(db, teamId, "person@plans.invalid")).toMatchObject({
      ok: true,
    });
  });
});
