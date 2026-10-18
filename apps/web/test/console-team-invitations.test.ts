import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SimpleEmail } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";
import { setConsoleInvitationMailDeps } from "@/server/routers/console/team-invitations";

// Synthetic people and teams only; the mail is captured, nothing leaves.
let db: Db;
let close: () => Promise<void>;
let teamA: string;
let teamB: string;
let sent: SimpleEmail[];
let failSends = false;

const OPERATOR = "op";
const OWNER_A = "owner-a";
const ADMIN_A = "admin-a";
const OWNER_B = "owner-b";
const INVITEE = "invitee";
const STRANGER = "stranger";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // The first registered user is the instance operator.
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.test", createdAt: new Date(0) },
    { id: OWNER_A, name: "Owner A", email: "owner-a@example.test", createdAt: new Date(1) },
    { id: ADMIN_A, name: "Admin A", email: "admin-a@example.test", createdAt: new Date(2) },
    { id: OWNER_B, name: "Owner B", email: "owner-b@example.test", createdAt: new Date(3) },
    { id: INVITEE, name: "Invitee", email: "invitee@example.test", createdAt: new Date(4) },
    { id: STRANGER, name: "Stranger", email: "stranger@example.test", createdAt: new Date(5) },
  ]);
  teamA = await createTeam(db, "lab-a");
  teamB = await createTeam(db, "lab-b");
  await db.insert(schema.teamMembers).values([
    { teamId: teamA, userId: OWNER_A, role: "owner" },
    { teamId: teamA, userId: ADMIN_A, role: "admin" },
    { teamId: teamB, userId: OWNER_B, role: "owner" },
  ]);
});
afterAll(() => close());

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-invite-secret");
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <no-reply@mail.example.test>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
  sent = [];
  failSends = false;
  setConsoleInvitationMailDeps({
    send: async (message) => {
      if (failSends) throw new Error("ses down");
      sent.push(message as SimpleEmail);
    },
  });
  // The audit log is append-only: assertions pick their rows by target.
  await db.delete(schema.teamInvitations);
});
afterEach(() => {
  setConsoleInvitationMailDeps(null);
  vi.unstubAllEnvs();
});

function callerFor(
  userId: string,
  team: string | null = null,
  role: TeamRole | null = null,
  setActiveTeamCookie?: (teamId: string) => void,
) {
  return createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.test`, name: userId },
      session: { id: `s-${userId}`, createdAt: new Date() },
    },
    teamId: team,
    role,
    ...(setActiveTeamCookie ? { setActiveTeamCookie } : {}),
  });
}

const operator = (setActiveTeamCookie?: (teamId: string) => void) =>
  callerFor(OPERATOR, null, null, setActiveTeamCookie);

function tokenFromUrl(acceptUrl: string): string {
  const token = acceptUrl.split("/invite/")[1];
  if (!token) throw new Error(`no token in ${acceptUrl}`);
  return token;
}

async function auditRows(action: string, invitationId: string) {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, action))
    .orderBy(desc(schema.auditLog.createdAt));
  return rows.filter((row) => row.target === `invitation:${invitationId}`);
}

async function membership(teamId: string, userId: string) {
  const [row] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
  return row ?? null;
}

describe("console.teams.invitations.create", () => {
  it("invites into a team the operator is not in, as a member by default, without joining it", async () => {
    const setActive = vi.fn();
    const created = await operator(setActive).console.teams.invitations.create({
      teamId: teamA,
      email: "Invitee@Example.TEST",
    });
    expect(created).toMatchObject({
      email: "invitee@example.test",
      role: "member",
      emailed: true,
      teamName: "lab-a",
    });
    expect(created.acceptUrl).toContain("/invite/");

    const [row] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(row).toMatchObject({
      teamId: teamA,
      email: "invitee@example.test",
      role: "member",
      invitedByUserId: OPERATOR,
      sendCount: 1,
    });
    // The real sender's name goes out, to the invited address only.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("invitee@example.test");

    // The operator is in no team and its active team was never touched.
    const operatorTeams = await db
      .select()
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, OPERATOR));
    expect(operatorTeams).toHaveLength(0);
    expect(setActive).not.toHaveBeenCalled();

    const [audit] = await auditRows("team.member_invited", created.id);
    expect(audit).toMatchObject({
      teamId: teamA,
      actorId: `user:${OPERATOR}`,
      target: `invitation:${created.id}`,
      data: { team: "lab-a", email: "invitee@example.test", role: "member", emailed: true },
    });
    // Never the accept link or its token.
    const recorded = JSON.stringify(audit);
    expect(recorded).not.toContain("/invite/");
    expect(recorded).not.toContain(tokenFromUrl(created.acceptUrl));
  });

  it("invites an admin only when asked, and never an owner", async () => {
    const admin = await operator().console.teams.invitations.create({
      teamId: teamA,
      email: "second-admin@example.test",
      role: "admin",
    });
    expect(admin.role).toBe("admin");
    await expect(
      operator().console.teams.invitations.create({
        teamId: teamA,
        email: "would-be-owner@example.test",
        // biome-ignore lint/suspicious/noExplicitAny: the owner role is refused at the boundary.
        role: "owner" as any,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const rows = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.email, "would-be-owner@example.test"));
    expect(rows).toHaveLength(0);
  });

  it("keeps the shared invitation rules: one pending invite per address, a failed send reported", async () => {
    await operator().console.teams.invitations.create({ teamId: teamA, email: "dup@example.test" });
    await expect(
      operator().console.teams.invitations.create({ teamId: teamA, email: "DUP@example.test" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    failSends = true;
    const unsent = await operator().console.teams.invitations.create({
      teamId: teamA,
      email: "unsent@example.test",
    });
    expect(unsent.emailed).toBe(false);
    const [audit] = await auditRows("team.member_invited", unsent.id);
    expect(audit?.data).toMatchObject({ email: "unsent@example.test", emailed: false });
  });

  it("refuses a team that does not exist", async () => {
    await expect(
      operator().console.teams.invitations.create({
        teamId: "00000000-0000-4000-8000-0000000000ff",
        email: "nobody@example.test",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("console.teams.invitations: only the operator", () => {
  it("is NOT_FOUND for a team owner, a team admin and a user in no team", async () => {
    const callers = [
      callerFor(OWNER_A, teamA, "owner"),
      callerFor(ADMIN_A, teamA, "admin"),
      callerFor(STRANGER),
    ];
    for (const caller of callers) {
      await expect(
        caller.console.teams.invitations.create({ teamId: teamA, email: "x@example.test" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(caller.console.teams.invitations.list({ teamId: teamA })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(await db.select().from(schema.teamInvitations)).toHaveLength(0);
  });

  it("leaves the team's own invitations to its owners and admins", async () => {
    // Team B's owner cannot reach team A through the team procedures either.
    await callerFor(OWNER_B, teamB, "owner").settings.invitations.create({
      email: "b-only@example.test",
    });
    const rows = await db.select().from(schema.teamInvitations);
    expect(rows.map((row) => row.teamId)).toEqual([teamB]);
  });
});

describe("console.teams.invitations: two teams stay apart", () => {
  it("lists, resends and revokes only within the team named", async () => {
    const inA = await operator().console.teams.invitations.create({
      teamId: teamA,
      email: "only-a@example.test",
    });
    expect(
      (await operator().console.teams.invitations.list({ teamId: teamA })).map((i) => i.id),
    ).toEqual([inA.id]);
    expect(await operator().console.teams.invitations.list({ teamId: teamB })).toEqual([]);

    await expect(
      operator().console.teams.invitations.resend({ teamId: teamB, id: inA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operator().console.teams.invitations.revoke({ teamId: teamB, id: inA.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Team A's own admins see the operator's invitation; team B's owner does not.
    const teamAList = await callerFor(ADMIN_A, teamA, "admin").settings.invitations.list();
    expect(teamAList.map((i) => i.id)).toEqual([inA.id]);
    expect(await callerFor(OWNER_B, teamB, "owner").settings.invitations.list()).toEqual([]);
  });
});

describe("console.teams.invitations: accept, resend and revoke", () => {
  it("joins only the invited team, for the invited address only (Cloud)", async () => {
    const created = await operator().console.teams.invitations.create({
      teamId: teamA,
      email: "invitee@example.test",
    });
    const token = tokenFromUrl(created.acceptUrl);
    vi.stubEnv("IS_CLOUD", "true");

    await expect(callerFor(STRANGER).settings.invitations.accept({ token })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await membership(teamA, STRANGER)).toBeNull();

    await expect(callerFor(INVITEE).settings.invitations.accept({ token })).resolves.toEqual({
      teamId: teamA,
    });
    expect(await membership(teamA, INVITEE)).toEqual({ role: "member" });
    expect(await membership(teamB, INVITEE)).toBeNull();
    // Single use: the link is spent.
    await expect(callerFor(INVITEE).settings.invitations.accept({ token })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamA), eq(schema.teamMembers.userId, INVITEE)));
  });

  it("resends and revokes with the operator in the audit", async () => {
    const created = await operator().console.teams.invitations.create({
      teamId: teamA,
      email: "resend@example.test",
      role: "admin",
    });
    // Past the per-invite cooldown.
    await db
      .update(schema.teamInvitations)
      .set({ lastSentAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.teamInvitations.id, created.id));

    await operator().console.teams.invitations.resend({ teamId: teamA, id: created.id });
    expect(sent).toHaveLength(2);
    const [resent] = await auditRows("team.invitation_resent", created.id);
    expect(resent).toMatchObject({
      teamId: teamA,
      actorId: `user:${OPERATOR}`,
      target: `invitation:${created.id}`,
      data: { email: "resend@example.test", role: "admin", emailed: true },
    });

    // Too soon for another send: the shared cooldown holds.
    await expect(
      operator().console.teams.invitations.resend({ teamId: teamA, id: created.id }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    await operator().console.teams.invitations.revoke({ teamId: teamA, id: created.id });
    expect(
      await db
        .select()
        .from(schema.teamInvitations)
        .where(eq(schema.teamInvitations.id, created.id)),
    ).toHaveLength(0);
    const [revoked] = await auditRows("team.invitation_revoked", created.id);
    expect(revoked).toMatchObject({
      teamId: teamA,
      actorId: `user:${OPERATOR}`,
      data: { email: "resend@example.test", role: "admin" },
    });
    for (const row of [resent, revoked]) expect(JSON.stringify(row)).not.toContain("/invite/");

    // Revoked means gone: a second revoke finds nothing.
    await expect(
      operator().console.teams.invitations.revoke({ teamId: teamA, id: created.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
