import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountMailPhrase, buildAccountMail } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { warnMailboxPlanUsage } from "../src/handlers/mailbox-plan-alerts.js";
import type { SystemMailer } from "../src/system-mail.js";

const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const GiB = 1024 ** 3;
const now = new Date(Date.UTC(2026, 9, 20, 12));
const periodStart = new Date(Date.UTC(2026, 9, 10, 19));
const periodEnd = new Date(Date.UTC(2026, 10, 10, 19));
let db: Db;
let close: () => Promise<void>;
let teamId: string;
let legacyTeam: string;
const sent: { to: string; subject: string; text: string; kind: string }[] = [];
const mailer = {
  send: async (to: string, m: { subject: string; text: string; kind: string }) => {
    sent.push({ to, subject: m.subject, text: m.text, kind: m.kind });
  },
} as unknown as SystemMailer;
const run = () => warnMailboxPlanUsage(db, { mailer, appBaseUrl: "https://app.example", now });
const usage = (inboundDeliveries: number) =>
  db
    .insert(schema.mailboxUsagePeriods)
    .values({ teamId, periodStart, periodEnd, inboundDeliveries, inboundBytes: 0 })
    .onConflictDoUpdate({
      target: [schema.mailboxUsagePeriods.teamId, schema.mailboxUsagePeriods.periodStart],
      set: { inboundDeliveries },
    });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "Acme");
  legacyTeam = await createTeam(db, "Legacy");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "legacy", name: "Legacy", email: "legacy@example.invalid" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId: legacyTeam, userId: "legacy", role: "owner" },
  ]);
  const base = { status: "active" as const, periodStart, periodEnd };
  await db.insert(schema.mailboxSubscriptions).values([
    {
      ...base,
      teamId,
      planCode: "solo",
      quotaScope: "team",
      seats: 1,
      includedMailboxes: 1,
      storageBytesPerMailbox: GiB,
      includedOutboundPerMailbox: 500,
      inboundDeliveriesPerPeriod: 2000,
      inboundBytesPerPeriod: GiB / 2,
      outboundBytesPerPeriod: GiB / 4,
    },
    // Terms sold before the plans have no plan allowances and never hear from this sweep.
    {
      ...base,
      teamId: legacyTeam,
      seats: 3,
      storageBytesPerMailbox: 10 * GiB,
      includedOutboundPerMailbox: 0,
    },
  ]);
});
afterAll(() => close());

describe("Correio plan usage notices", () => {
  it("says 80% once, then the limit once, per billing month and limit", async () => {
    await usage(1000);
    expect(await run()).toEqual({ near: 0, reached: 0, paused: 0 });
    await usage(1700);
    expect(await run()).toEqual({ near: 1, reached: 0, paused: 0 });
    expect(sent.at(-1)).toMatchObject({
      to: "owner@example.invalid",
      kind: "mailbox.usage_near",
      subject: "Acme: messages received at 85% of the Solo plan",
    });
    expect(sent.at(-1)?.text).toContain("Acme has received 1,700 of the 2,000 messages");
    expect(sent.at(-1)?.text).toContain("November 10, 2026");
    expect(sent.at(-1)?.text).toContain("move to the Duo plan in Mail");
    expect(sent.at(-1)?.text).toContain("https://app.example/mail/settings");
    expect(await run()).toEqual({ near: 0, reached: 0, paused: 0 });
    await usage(2050);
    expect(await run()).toEqual({ near: 0, reached: 1, paused: 0 });
    expect(sent.at(-1)?.subject).toBe("Acme: messages received limit reached on the Solo plan");
    expect(await run()).toEqual({ near: 0, reached: 0, paused: 0 });
    expect(sent.every((m) => m.to === "owner@example.invalid")).toBe(true);
  });

  it("tells about a receiving pause once, with its reason and when it ends", async () => {
    await db
      .insert(schema.mailboxReceivingHolds)
      .values({ teamId, reason: "inbound_deliveries", periodEnd, state: "pausing" });
    // Only a pause SES applied is news: "pausing" is not yet.
    expect((await run()).paused).toBe(0);
    await db
      .update(schema.mailboxReceivingHolds)
      .set({ state: "paused" })
      .where(eq(schema.mailboxReceivingHolds.teamId, teamId));
    expect((await run()).paused).toBe(1);
    expect(sent.at(-1)).toMatchObject({
      kind: "mailbox.receiving_paused",
      subject: "Acme: Mail receiving is paused",
    });
    expect(sent.at(-1)?.text).toContain("passed the Solo plan's limit");
    expect(sent.at(-1)?.text).toContain("renews on November 10, 2026");
    expect((await run()).paused).toBe(0);
  });

  it("goes straight to the limit notice when a limit is passed between two sweeps", async () => {
    // 0 to 600 MiB received at once: past the 512 MiB limit without an 80% sweep in between.
    await db
      .update(schema.mailboxUsagePeriods)
      .set({ inboundBytes: 600 * 1024 ** 2 })
      .where(eq(schema.mailboxUsagePeriods.teamId, teamId));
    expect(await run()).toEqual({ near: 0, reached: 1, paused: 0 });
    expect(sent.at(-1)?.subject).toBe("Acme: received mail limit reached on the Solo plan");
    expect(sent.at(-1)?.text).toContain(
      "the 512 MiB of mail included this billing month (600 MiB so far)",
    );
    // The 80% notice of that month was settled by the limit one: nothing more follows.
    expect(await run()).toEqual({ near: 0, reached: 0, paused: 0 });
  });

  it("fills every slot in both languages", () => {
    const values = {
      team: "Acme",
      plan: "Duo",
      used: "1,7",
      limit: "2",
      share: "85%",
      date: "10 de novembro de 2026",
      since: "20 de outubro de 2026",
      next: "Equipe",
    };
    for (const locale of ["en", "pt-BR"] as const) {
      for (const kind of ["mailbox.usage_near", "mailbox.usage_reached"] as const)
        for (const metric of [
          "outboundRecipients",
          "outboundBytes",
          "inboundDeliveries",
          "inboundBytes",
          "storageBytes",
        ]) {
          const mail = buildAccountMail({
            kind,
            locale,
            url: "https://app.example/mail/settings",
            values: {
              ...values,
              title: accountMailPhrase({ locale, kind, key: `title_${metric}` }),
              detail: accountMailPhrase({ locale, kind, key: metric, values }),
              upgradeLine: accountMailPhrase({ locale, kind, key: "upgrade", values }),
            },
          });
          expect(`${mail.subject} ${mail.text}`).not.toMatch(/\{\w+\}/);
          expect(`${mail.subject} ${mail.text}`).not.toMatch(/—/);
        }
      for (const reason of ["inbound_deliveries", "inbound_bytes", "storage"]) {
        const kind = "mailbox.receiving_paused" as const;
        const mail = buildAccountMail({
          kind,
          locale,
          url: "https://app.example/mail/settings",
          values: {
            ...values,
            reason: accountMailPhrase({ locale, kind, key: `reason_${reason}`, values }),
            resume: accountMailPhrase({ locale, kind, key: "resumeStorage", values }),
            upgradeLine: accountMailPhrase({ locale, kind, key: "largest" }),
          },
        });
        expect(`${mail.subject} ${mail.text}`).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
