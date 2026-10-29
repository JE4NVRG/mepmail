import { holdTeamForReview, type SystemMailMessage } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
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
  it("releases an exactly observed six-fraction hold without rewriting its timestamp", async () => {
    const id = await fixture();
    await db.execute(
      sql`update teams set send_review_at='2026-10-22T21:00:00.000123Z'::timestamptz where id=${id}`,
    );
    await operator().console.teams.releaseSendReview({
      id,
      expectedHoldAt: "2026-10-22T21:00:00.000123Z",
    });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    expect(team?.sendReviewAt).toBeNull();
    expect(team?.sendReviewClearedBy).toBe("review-operator");
    expect(h.sent).toHaveLength(1);
    expect(h.runCronNow).toHaveBeenCalledWith("quota.drain");
  });

  it("never clears a newer hold one microsecond after the observed hold", async () => {
    const id = await fixture();
    await db.execute(
      sql`update teams set send_review_at='2026-10-22T21:00:00.000124Z'::timestamptz where id=${id}`,
    );
    await operator().console.teams.releaseSendReview({
      id,
      expectedHoldAt: "2026-10-22T21:00:00.000123Z",
    });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    expect(team?.sendReviewAt).not.toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(h.runCronNow).not.toHaveBeenCalled();
  });

  it("rejects a stale operator snapshot without clearing a newer hold or draining", async () => {
    const id = await fixture();
    const newer = new Date(heldAt.getTime() + 1000);
    await db.update(schema.teams).set({ sendReviewAt: newer }).where(eq(schema.teams.id, id));
    await expect(
      operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() }),
    ).rejects.toThrow("review changed");
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    expect(team?.sendReviewAt).toEqual(newer);
    expect(h.sent).toHaveLength(0);
    expect(h.runCronNow).not.toHaveBeenCalled();
  });

  it("does not let a manual release override an actively paused rolling metric", async () => {
    const id = await fixture();
    const now = Date.now();
    const accepted = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 100 }, () => ({
          teamId: id,
          from: "service@example.test",
          to: ["recipient@example.test"],
          subject: "Synthetic outcome",
          createdAt: new Date(now - 7200000),
          sentAt: new Date(now - 3600000),
          sesMessageId: crypto.randomUUID(),
        })),
      )
      .returning({ id: schema.emails.id });
    await db.insert(schema.emailEvents).values(
      accepted.slice(0, 3).map((email) => ({
        emailId: email.id,
        type: "bounced" as const,
        bounceType: "Permanent",
        snsMessageId: crypto.randomUUID(),
        occurredAt: new Date(now - 1800000),
        createdAt: new Date(now - 1800000),
      })),
    );
    await expect(
      operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() }),
    ).rejects.toThrow("24-hour sending safety");
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
    expect(team?.sendReviewAt).toEqual(heldAt);
    expect(h.runCronNow).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });
  it("releases once and tells the owner once across concurrent requests and replay", async () => {
    const id = await fixture();
    await Promise.all([
      operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() }),
      operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() }),
    ]);
    await operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() });
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
      await expect(
        operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() }),
      ).rejects.toThrow("suspended team");
      expect(h.sent).toHaveLength(0);
      const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(team).toMatchObject({ suspendedAt: heldAt, suspensionReason: reason });
    },
  );

  it("keeps payment-screening evidence out of the owner's release message", async () => {
    const id = await fixture("payment_risk");
    await operator().console.teams.releaseSendReview({ id, expectedHoldAt: heldAt.toISOString() });
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
      await operator().console.teams.releaseSendReview({
        id,
        expectedHoldAt: heldAt.toISOString(),
      });
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
