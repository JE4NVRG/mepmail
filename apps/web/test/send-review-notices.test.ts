import { holdTeamForReview, type SystemMailMessage } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

const h = vi.hoisted(() => ({
  sent: [] as SystemMailMessage[],
  failPreparation: false,
  runCronNow: vi.fn(async (_name: string) => {}),
}));
vi.mock("@/server/queue", () => ({
  getQueue: async () => ({ runCronNow: h.runCronNow }),
  enqueueEmailSend: async () => {},
  enqueueWebhookDeliveries: async () => {},
  enqueueRecipientErase: async () => {},
}));
vi.mock("@/server/routers/console/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/routers/console/shared")>();
  return {
    ...actual,
    mailTeamOwners: (...args: Parameters<typeof actual.mailTeamOwners>) => {
      if (h.failPreparation) throw new Error("SYNTHETIC-OWNER-LOOKUP-FAILURE");
      return actual.mailTeamOwners(...args);
    },
  };
});
vi.mock("@/server/system-mail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/system-mail")>();
  return { ...actual, sendAccountMail: (mail: SystemMailMessage) => void h.sent.push(mail) };
});

const heldAt = new Date("2026-10-22T21:00:00.000Z");
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    {
      id: "review-operator",
      name: "Operator",
      email: "operator@example.test",
      createdAt: new Date(0),
    },
    { id: "review-owner", name: "Owner", email: "owner@example.test", createdAt: heldAt },
  ]);
});
afterAll(() => close());
beforeEach(() => {
  h.sent.length = 0;
  h.failPreparation = false;
  h.runCronNow.mockClear();
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <notices@example.test>");
  vi.stubEnv("APP_BASE_URL", "https://app.example.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("external network forbidden");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function operator() {
  return createCaller({
    db,
    session: {
      user: { id: "review-operator", email: "operator@example.test", name: "Operator" },
      session: { id: "review-session", createdAt: heldAt },
    },
    teamId: null,
    role: null,
  });
}

async function fixture(reason: "new_sender" | "payment_risk" = "new_sender") {
  const id = await createTeam(db, `review-${crypto.randomUUID()}`);
  await db.insert(schema.teamMembers).values({ teamId: id, userId: "review-owner", role: "owner" });
  await holdTeamForReview(db, {
    teamId: id,
    reason,
    note:
      reason === "new_sender"
        ? "Sending domain of PRIVATE-SENDER@example.online is under .online, a TLD abuse feeds rank as mostly malicious"
        : "PRIVATE-PAYMENT-EVIDENCE",
    now: heldAt,
  });
  return id;
}

describe("send review release notices", () => {
  it("releases once and tells the owner once across concurrent requests and replay", async () => {
    const id = await fixture();
    await Promise.all([
      operator().console.teams.releaseSendReview({ id }),
      operator().console.teams.releaseSendReview({ id }),
    ]);
    await operator().console.teams.releaseSendReview({ id });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: "owner@example.test", kind: "review.released" });
    expect(h.sent[0]?.text).toContain(".online");
    expect(h.sent[0]?.text).toContain("does not confirm delivery");
    expect(h.sent[0]?.text).not.toContain("PRIVATE-SENDER");
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    expect(team).toMatchObject({ sendReviewAt: null, sendReviewClearedBy: "review-operator" });
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, id));
    const releases = audits.filter((row) => row.action === "team.send_review_released");
    expect(releases).toHaveLength(1);
    expect(releases[0]?.data).toMatchObject({
      notificationRecipients: 1,
      notificationPreparationFailed: false,
    });
    expect(JSON.stringify(releases)).not.toContain("PRIVATE-SENDER");
    const claims = await db
      .select()
      .from(schema.teamNotifications)
      .where(eq(schema.teamNotifications.teamId, id));
    expect(claims).toMatchObject([{ kind: "review.released", periodKey: heldAt.toISOString() }]);
  });

  it.each(["phishing", "manual"] as const)(
    "does not send a normalization notice while a %s suspension remains active",
    async (reason) => {
      const id = await fixture();
      await db
        .update(schema.teams)
        .set({ suspendedAt: heldAt, suspensionReason: reason })
        .where(eq(schema.teams.id, id));
      await operator().console.teams.releaseSendReview({ id });
      expect(h.sent).toHaveLength(0);
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(team).toMatchObject({ suspendedAt: heldAt, suspensionReason: reason });
    },
  );

  it("keeps payment-screening evidence out of the owner's release message", async () => {
    const id = await fixture("payment_risk");
    await operator().console.teams.releaseSendReview({ id });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).not.toContain("PRIVATE-PAYMENT-EVIDENCE");
    expect(h.sent[0]?.text).not.toContain("fraud");
    expect(h.sent[0]?.text).toContain("protections remain active");
  });

  it("records a notice preparation failure without undoing the release or drain kick", async () => {
    const id = await fixture();
    h.failPreparation = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await operator().console.teams.releaseSendReview({ id });
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(team?.sendReviewAt).toBeNull();
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, id));
      expect(audits.find((row) => row.action === "team.send_review_released")?.data).toMatchObject({
        notificationRecipients: 0,
        notificationPreparationFailed: true,
      });
      expect(h.sent).toHaveLength(0);
      expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");
    } finally {
      quiet.mockRestore();
    }
  });
});
