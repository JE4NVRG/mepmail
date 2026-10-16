import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SystemMailMessage } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSuspensionSesDeps } from "@/server/console/suspension";
import { createCaller } from "@/server/routers";

const sent = vi.hoisted(() => [] as SystemMailMessage[]);
const noticeSeam = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/routers/console/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/routers/console/shared")>();
  return {
    ...actual,
    mailTeamOwners: (...args: Parameters<typeof actual.mailTeamOwners>) => {
      if (noticeSeam.fail) throw new Error("SYNTHETIC-LOOKUP-FAILURE");
      return actual.mailTeamOwners(...args);
    },
  };
});
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: async () => {} }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (mail: SystemMailMessage) => void sent.push(mail) };
});

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const extension = fileURLToPath(
    new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
  );
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(extension + file, "utf8")
      .split("--> statement-breakpoint")
      .filter((part) => part.trim())) {
      await db.execute(sql.raw(statement));
    }
  }
  await db.insert(schema.user).values([
    { id: "op", name: "Operator", email: "op@example.test" },
    { id: "owner-notices", name: "Owner", email: "owner@example.test" },
  ]);
});
afterAll(() => close());
beforeEach(() => {
  sent.length = 0;
  noticeSeam.fail = false;
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <notices@example.test>");
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("APP_BASE_URL", "https://app.example.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("external network forbidden");
    }),
  );
  setSuspensionSesDeps({ deleteTenant: async () => {}, deleteIdentity: async () => {} });
});
afterEach(() => {
  setSuspensionSesDeps(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function operator() {
  return createCaller({
    db,
    session: {
      user: { id: "op", email: "op@example.test", name: "Operator" },
      session: { id: "notice-session", createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });
}

async function fixture(plan: "free" | "pro", mailbox = false) {
  const id = await createTeam(db, `notice-${crypto.randomUUID()}`);
  await db
    .update(schema.teams)
    .set({ plan, planStatus: plan === "pro" ? "active" : "none" })
    .where(eq(schema.teams.id, id));
  await db
    .insert(schema.teamMembers)
    .values({ teamId: id, userId: "owner-notices", role: "owner" });
  if (mailbox)
    await db.insert(schema.mailboxSubscriptions).values({
      teamId: id,
      status: "active",
      storageBytesPerMailbox: 1024,
      includedOutboundPerMailbox: 100,
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
    });
  return id;
}

describe("a paying team's suspension notice", () => {
  it.each([false, true])(
    "requires notice despite notify=false (Correio-only=%s), without investigation notes",
    async (mailbox) => {
      const id = await fixture(mailbox ? "free" : "pro", mailbox);
      await operator().console.teams.suspend({
        id,
        reason: "phishing",
        note: "PRIVATE-INVESTIGATION-EVIDENCE",
        notify: false,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.kind).toBe("team.suspended");
      expect(sent[0]?.text).toContain("/support");
      expect(sent[0]?.text).not.toContain("PRIVATE-INVESTIGATION-EVIDENCE");
      expect(sent[0]?.text).not.toContain("within a minute");
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(team?.suspendedAt).toBeInstanceOf(Date);
      expect(team?.suspensionNote).toBe("PRIVATE-INVESTIGATION-EVIDENCE");
      const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, id));
      expect(audit?.data).toMatchObject({ paidNoticeRequired: true, notified: true });
    },
  );

  it("preserves silent phishing handling for an unpaid team", async () => {
    const id = await fixture("free");
    await operator().console.teams.suspend({ id, reason: "phishing", notify: true });
    expect(sent).toHaveLength(0);
  });

  it("requires a notice for a paid manual suspension even when unchecked", async () => {
    const id = await fixture("pro");
    await operator().console.teams.suspend({
      id,
      reason: "manual",
      note: "Please contact support",
      notify: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Please contact support");
  });

  it("records suspension and safety flag even when preparing the paid notice fails", async () => {
    const id = await fixture("pro");
    noticeSeam.fail = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await operator().console.teams.suspend({
        id,
        reason: "phishing",
        notify: false,
      });
      expect(result.notice).toEqual({ requested: true, recipients: 0, preparationFailed: true });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(team?.suspendedAt).toBeInstanceOf(Date);
      const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, id));
      expect(audit?.data).toMatchObject({
        notificationRequested: true,
        notified: false,
        notificationPreparationFailed: true,
      });
      const [flag] = await db
        .select()
        .from(schema.teamFlags)
        .where(eq(schema.teamFlags.teamId, id));
      expect(flag?.status).toBe("open");
      expect(sent).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});
