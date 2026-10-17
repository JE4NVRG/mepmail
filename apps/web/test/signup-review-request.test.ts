import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const context = "Transactional receipts for customers who opted in.";
const signals = {
  domain: "example.com",
  disposable: false,
  mx: "present" as const,
  domainAgeDays: 100,
  catchAll: "unknown" as const,
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
};
const caller = (
  role: "owner" | "admin" | "member" | null = "owner",
  team: string | null = teamId,
  authenticated = true,
) =>
  createCaller({
    db,
    session: authenticated
      ? { user: { id: "owner", name: "Synthetic", email: "owner@example.com" } }
      : null,
    teamId: team,
    role,
  });
const operator = () =>
  createCaller({
    db,
    session: { user: { id: "operator", name: "Operator", email: "operator@example.com" } },
    teamId: null,
    role: null,
  });

beforeEach(async () => {
  vi.stubEnv("IS_CLOUD", "true");
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: "operator", name: "Operator", email: "operator@example.com", createdAt: new Date(0) },
    {
      id: "owner",
      name: "Synthetic",
      email: "owner@example.com",
      emailVerified: true,
      createdAt: new Date(1),
    },
  ]);
  teamId = await createTeam(db, "review-team");
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  await db.insert(schema.teamSignupRisk).values({
    teamId,
    principalUserId: "owner",
    level: "sandbox",
    policyVersion: 1,
    reasons: ["unknown_domain_age"],
    signals,
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

describe("authenticated private signup review", () => {
  it("requires a session, team membership and admin authority", async () => {
    await expect(
      caller("owner", teamId, false).team.requestSignupReview({ context }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller(null, null).team.requestSignupReview({ context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller("member").team.requestSignupReview({ context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await db.select().from(schema.signupRiskReviewRequests)).toHaveLength(0);
  });

  it("normalizes one line, deduplicates retries, audits atomically and returns no context", async () => {
    const receipt = await caller().team.requestSignupReview({
      context: `  ${context}\n\tRecipient consent confirmed.\u200b `,
    });
    const retry = await caller().team.requestSignupReview({
      context: "Another context that must not overwrite the first request.",
    });
    expect(receipt).toEqual(retry);
    expect(JSON.stringify(receipt)).not.toContain(context);
    const [request] = await db.select().from(schema.signupRiskReviewRequests);
    expect(request).toMatchObject({
      teamId,
      requestedBy: "owner",
      context: `${context} Recipient consent confirmed.`,
      resolvedAt: null,
    });
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "team.signup_risk_review_requested"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(context);
    expect(await caller().team.signupReview()).toMatchObject({ pending: true });
    expect(JSON.stringify(await caller().team.signupReview())).not.toContain(context);
  });

  it("binds the request to the active membership and rejects context limits", async () => {
    const other = await createTeam(db, "another-team");
    await caller().team.requestSignupReview({ context, teamId: other } as { context: string });
    expect((await db.select().from(schema.signupRiskReviewRequests))[0]?.teamId).toBe(teamId);
    await expect(caller().team.requestSignupReview({ context: "too short" })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
    await expect(
      caller().team.requestSignupReview({ context: "x".repeat(501) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rolls back the request if mandatory audit fails and exposes no SQL/context", async () => {
    await db.execute(
      sql.raw(
        `CREATE FUNCTION reject_signup_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'team.signup_risk_review_requested' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`,
      ),
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER reject_signup_review_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_signup_review_audit()`,
      ),
    );
    const error = await caller()
      .team.requestSignupReview({ context })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "review_request_failed",
    });
    expect(String(error)).not.toContain(context);
    expect(await db.select().from(schema.signupRiskReviewRequests)).toHaveLength(0);
  });

  it("resolves only the request and rate limits reopening without touching restrictions", async () => {
    const heldAt = new Date();
    await db
      .update(schema.teams)
      .set({
        sendReviewAt: heldAt,
        sendReviewReason: "content",
        suspendedAt: heldAt,
        suspensionReason: "manual",
      })
      .where(eq(schema.teams.id, teamId));
    await caller().team.requestSignupReview({ context });
    expect(
      await operator().console.teams.resolveSignupReview({ id: teamId, reviewed: true }),
    ).toEqual({ changed: true });
    expect(
      await operator().console.teams.resolveSignupReview({ id: teamId, reviewed: true }),
    ).toEqual({ changed: false });
    await expect(caller().team.requestSignupReview({ context })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    const [risk] = await db
      .select()
      .from(schema.teamSignupRisk)
      .where(eq(schema.teamSignupRisk.teamId, teamId));
    expect(team).toMatchObject({ sendReviewAt: heldAt, suspendedAt: heldAt });
    expect(risk).toMatchObject({ level: "sandbox", policyVersion: 1, clearedAt: null });
    const old = new Date(Date.now() - 86_400_001);
    await db
      .update(schema.signupRiskReviewRequests)
      .set({ requestedAt: old, updatedAt: old })
      .where(eq(schema.signupRiskReviewRequests.teamId, teamId));
    await expect(caller().team.requestSignupReview({ context })).resolves.toMatchObject({
      pending: true,
    });
  });

  it("includes every sandbox and legacy hold without enrolling or backfilling the legacy team", async () => {
    const legacy = await createTeam(db, "legacy-hold");
    await db
      .update(schema.teams)
      .set({ sendReviewAt: new Date(), sendReviewReason: "new_sender" })
      .where(eq(schema.teams.id, legacy));
    const queue = await operator().console.safety.signupReviews({});
    expect(queue.items.map((row) => row.teamId)).toEqual(expect.arrayContaining([teamId, legacy]));
    expect(queue.items.find((row) => row.teamId === legacy)).toMatchObject({
      level: null,
      restriction: "held",
      paid: false,
    });
    expect(queue.items.find((row) => row.teamId === teamId)).toMatchObject({
      level: "sandbox",
      restriction: "sandbox",
      reasons: ["unknown_domain_age"],
    });
    expect(await db.select().from(schema.teamSignupRisk)).toHaveLength(1);
    expect(await db.select().from(schema.teamFlags)).toHaveLength(0);
  });

  it("DDL accepts v2 and preserves v1, and rejects unsupported policy versions", async () => {
    const second = await createTeam(db, "policy-two");
    await db.insert(schema.teamSignupRisk).values({
      teamId: second,
      level: "hold",
      policyVersion: 2,
      signals: { ...signals, verificationSeconds: 5, genericTeamName: true },
    });
    expect(
      (await db.select().from(schema.teamSignupRisk)).map((row) => row.policyVersion).sort(),
    ).toEqual([1, 2]);
    await expect(
      db
        .update(schema.teamSignupRisk)
        .set({ policyVersion: 3 })
        .where(eq(schema.teamSignupRisk.teamId, second)),
    ).rejects.toThrow();
    const [risk] = await db
      .select()
      .from(schema.teamSignupRisk)
      .where(eq(schema.teamSignupRisk.teamId, teamId));
    expect(risk).toMatchObject({ policyVersion: 1, level: "sandbox", clearedAt: null });
  });
});
