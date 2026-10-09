import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, like } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepActivation, sweepNotifications } from "../src/handlers/notify.js";

const HOUR = 3_600_000;
let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string }[];
const created = new Date("2026-10-01T12:00:00Z");
const at = (hours: number) => new Date(created.getTime() + hours * HOUR);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "acme");
  await db.update(schema.teams).set({ createdAt: created }).where(eq(schema.teams.id, teamId));
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  sends = [];
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const mailer = {
  send: async (to: string, m: { subject: string; text: string }) => {
    sends.push({ to, subject: m.subject, text: m.text });
  },
};
const sweep = (hours: number) => sweepActivation(db, mailer, "https://app.example.test", at(hours));
const claims = async () =>
  (
    await db
      .select({ kind: schema.teamNotifications.kind })
      .from(schema.teamNotifications)
      .where(like(schema.teamNotifications.kind, "activation.%"))
  )
    .map((c) => c.kind)
    .sort();
async function domain(hoursAfterTeam: number, status: "pending" | "verified" = "pending") {
  const [row] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "mail.acme.dev",
      region: "us-east-1",
      status,
      createdAt: at(hoursAfterTeam),
      ...(status === "verified" ? { verifiedAt: at(hoursAfterTeam + 1) } : {}),
    })
    .returning({ id: schema.domains.id });
  return row!.id;
}

it("a young team without a domain hears once that only the domain is left", async () => {
  expect(await sweep(10)).toBe(0);
  expect(await sweep(21)).toBe(1);
  expect(sends.map((s) => [s.to, s.subject])).toEqual([
    ["owner@example.com", "Just your domain left to start sending with MepMail"],
  ]);
  expect(sends[0]?.text).toContain("https://app.example.test/domains/new");
  expect(sends[0]?.text).toContain("https://app.example.test/support#chat");
  expect(await sweep(30)).toBe(0);
  expect(await claims()).toEqual(["activation.add_domain"]);
});

it("from three days on the reminder is an offer of help, once, and it stops after two weeks", async () => {
  await sweep(21);
  expect(await sweep(73)).toBe(1);
  expect(sends.map((s) => s.subject)).toEqual([
    "Just your domain left to start sending with MepMail",
    "Need a hand getting started with MepMail?",
  ]);
  expect(sends[1]?.text).toContain("https://app.example.test/support#chat");
  expect(sends[1]?.text).toContain("https://docs.mepmail.dev/concepts/domains");
  expect(await sweep(100)).toBe(0);
  // A team first seen when it is already a week old gets only the help offer.
  await db.delete(schema.teamNotifications);
  sends = [];
  expect(await sweep(24 * 7)).toBe(1);
  expect(sends.map((s) => s.subject)).toEqual(["Need a hand getting started with MepMail?"]);
  await db.delete(schema.teamNotifications);
  expect(await sweep(24 * 15)).toBe(0);
});

it("a domain still unverified hours after it was added gets one reminder with its deadline", async () => {
  const id = await domain(2);
  // The domain counts: no add_domain reminder for a team that already added one.
  expect(await sweep(7)).toBe(0);
  expect(await sweep(9)).toBe(1);
  expect(sends[0]?.subject).toBe("mail.acme.dev is not verified yet");
  expect(sends[0]?.text).toContain(`https://app.example.test/domains/${id}`);
  // Added at hour 2, so SES gives up 72 hours later.
  expect(sends[0]?.text).toContain("October 4, 2026 at 2:00 PM UTC");
  expect(await sweep(20)).toBe(0);
  expect(await claims()).toEqual([`activation.finish_domain:${id}`]);
});

it("verified teams, late domains, suspended teams and the instance's own team hear nothing", async () => {
  await domain(1, "verified");
  expect(await sweep(30)).toBe(0);
  expect(await sweep(80)).toBe(0);
  await db.delete(schema.domains);
  // A pending domain this close to SES's deadline is not worth a reminder.
  await domain(0);
  expect(await sweep(65)).toBe(0);
  await db.delete(schema.domains);
  await db.delete(schema.teamNotifications);
  await db
    .update(schema.teams)
    .set({ suspendedAt: at(1) })
    .where(eq(schema.teams.id, teamId));
  expect(await sweep(30)).toBe(0);
  await db
    .update(schema.teams)
    .set({ suspendedAt: null, plan: "system" })
    .where(eq(schema.teams.id, teamId));
  expect(await sweep(30)).toBe(0);
  expect(sends).toEqual([]);
});

it("an owner who turned getting-started reminders off is skipped; pt-BR owners read pt-BR", async () => {
  await db
    .update(schema.user)
    .set({ mailOptOuts: ["activation"] })
    .where(eq(schema.user.id, "owner"));
  expect(await sweep(21)).toBe(0);
  expect(sends).toEqual([]);

  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <account@mail.example.com>");
  const home = await createTeam(db, "home");
  await db
    .insert(schema.domains)
    .values({ teamId: home, name: "mail.example.com", region: "us-east-1", status: "verified" });
  await db
    .insert(schema.contacts)
    .values({ teamId: home, email: "owner@example.com", properties: { locale: "pt-BR" } });
  await db.update(schema.user).set({ mailOptOuts: [] }).where(eq(schema.user.id, "owner"));
  await domain(2);
  await sweep(9);
  expect(sends.map((s) => s.subject)).toEqual(["mail.acme.dev ainda não foi verificado"]);
  expect(sends[0]?.text).toContain("4 de outubro de 2026");
});

it("the notifications sweep runs the reminders on the cloud only", async () => {
  const deps = (isCloud: boolean) => ({
    isCloud,
    mailer,
    enqueueWebhook: async () => {},
    appBaseUrl: "https://app.example.test",
    now: at(21),
  });
  expect(await sweepNotifications(db, deps(false))).toEqual({ sent: 0 });
  expect(await sweepNotifications(db, deps(true))).toEqual({ sent: 1 });
  expect(sends.map((s) => s.subject)).toEqual([
    "Just your domain left to start sending with MepMail",
  ]);
});
