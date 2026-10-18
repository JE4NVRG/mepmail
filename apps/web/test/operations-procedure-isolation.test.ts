import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminProcedure,
  type Context,
  createCallerFactory,
  protectedProcedure,
  router,
  teamProcedure,
} from "@/server/trpc";

const USER = "operations-procedure-synthetic-user";
const DOMAIN = "00000000-0000-4000-8000-000000000001";
const access = {
  version: 1 as const,
  userDirectoryRead: true,
  mailboxCreateDomainIds: [DOMAIN],
};

describe("operational procedure boundary", () => {
  let db: Db;
  let close: () => Promise<void>;
  let teamId: string;
  let ownTeamId: string;
  const effect = vi.fn(() => ({ reached: true }));
  const query = protectedProcedure.query(effect);
  const mutation = protectedProcedure.mutation(effect);
  const scoped = teamProcedure.query(({ ctx }) => ({ role: ctx.role }));
  const makeCaller = createCallerFactory(
    router({
      console: router({
        users: router({ list: query }),
        teams: router({ list: query, update: mutation }),
      }),
      system: router({ operator: scoped, features: scoped, sendingPaused: scoped }),
      team: router({ list: query, switch: mutation, grantTeam: mutation, createTeam: mutation }),
      settings: router({
        team: router({ get: scoped, rename: mutation }),
        invitations: router({ accept: mutation, create: mutation }),
        members: router({ list: query, updateRole: mutation }),
        mailPreferences: router({ get: query, set: mutation }),
        usage: router({ get: query }),
      }),
      mailboxes: router({
        list: scoped,
        create: mutation,
        options: query,
        item: scoped,
        items: scoped,
        thread: scoped,
        saveDraft: mutation,
        queueDraft: mutation,
        folders: scoped,
        setSeen: mutation,
        preferences: router({ get: query, set: mutation }),
        service: query,
        usage: query,
        billing: query,
        grant: mutation,
        createAgentKey: mutation,
        createTeamAgentKey: mutation,
        grantOAuthClient: mutation,
        migration: router({ jobs: query, start: mutation }),
        futureRead: query,
        futureWrite: mutation,
      }),
      mailboxAgents: router({ list: query, create: mutation }),
      mailboxClients: router({ settings: query, create: mutation }),
      mailboxExternal: router({ available: query, connect: mutation }),
      apiKeys: router({ list: query, create: mutation }),
      connectedApps: router({ list: query }),
      billing: router({ summary: query, checkout: mutation }),
      emails: router({ list: query }),
      email: router({ send: mutation }),
      broadcasts: router({ list: query, send: mutation }),
      audience: router({ list: query }),
      suppressions: router({ list: query }),
      support: router({ current: query, end: mutation }),
      adminOnly: adminProcedure.mutation(effect),
      futureArea: router({ read: query, write: mutation }),
    }),
  );
  const memberWhere = () =>
    and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, USER));
  const as = (overrides: Partial<Context> = {}) =>
    makeCaller({
      db,
      teamId,
      // Deliberately stale/forged: every scoped procedure must resolve the row.
      role: "owner",
      session: {
        user: { id: USER, name: "Synthetic operator delegate", email: "synthetic@example.invalid" },
      },
      ...overrides,
    });

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    const teams = await db
      .insert(schema.teams)
      .values([
        { name: "Synthetic delegated team", slug: "operations-procedure-delegated" },
        { name: "Synthetic own team", slug: "operations-procedure-own" },
      ])
      .returning();
    teamId = teams[0]!.id;
    ownTeamId = teams[1]!.id;
    await db.insert(schema.user).values({
      id: USER,
      name: "Synthetic delegate",
      email: "synthetic@example.invalid",
      emailVerified: true,
    });
    await db.insert(schema.teamMembers).values([
      { teamId, userId: USER, role: "member", operationsAccess: access },
      { teamId: ownTeamId, userId: USER, role: "owner" },
    ]);
    effect.mockClear();
  });

  afterEach(async () => {
    await close();
  });

  it("denies protected-only credential, consent, content and billing endpoints before effects", async () => {
    const caller = as();
    const refused = [
      () => caller.team.grantTeam(),
      () => caller.team.createTeam(),
      () => caller.settings.team.rename(),
      () => caller.settings.invitations.create(),
      () => caller.settings.members.list(),
      () => caller.settings.members.updateRole(),
      () => caller.settings.usage.get(),
      () => caller.mailboxes.service(),
      () => caller.mailboxes.usage(),
      () => caller.mailboxes.billing(),
      () => caller.mailboxes.grant(),
      () => caller.mailboxes.createAgentKey(),
      () => caller.mailboxes.createTeamAgentKey(),
      () => caller.mailboxes.grantOAuthClient(),
      () => caller.mailboxes.migration.jobs(),
      () => caller.mailboxes.migration.start(),
      () => caller.mailboxAgents.list(),
      () => caller.mailboxAgents.create(),
      () => caller.mailboxClients.settings(),
      () => caller.mailboxClients.create(),
      () => caller.mailboxExternal.available(),
      () => caller.mailboxExternal.connect(),
      () => caller.apiKeys.list(),
      () => caller.apiKeys.create(),
      () => caller.connectedApps.list(),
      () => caller.billing.summary(),
      () => caller.billing.checkout(),
      () => caller.emails.list(),
      () => caller.email.send(),
      () => caller.broadcasts.list(),
      () => caller.broadcasts.send(),
      () => caller.audience.list(),
      () => caller.suppressions.list(),
    ];
    for (const run of refused) await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.console.teams.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.console.teams.update()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("keeps only the reviewed session, directory and Correio procedure pairs open", async () => {
    const caller = as();
    for (const run of [
      () => caller.console.users.list(),
      () => caller.team.list(),
      () => caller.team.switch(),
      () => caller.settings.invitations.accept(),
      () => caller.settings.mailPreferences.get(),
      () => caller.settings.mailPreferences.set(),
      () => caller.mailboxes.options(),
      () => caller.mailboxes.create(),
      () => caller.mailboxes.saveDraft(),
      () => caller.mailboxes.queueDraft(),
      () => caller.mailboxes.setSeen(),
      () => caller.mailboxes.preferences.get(),
      () => caller.mailboxes.preferences.set(),
      () => caller.support.current(),
      () => caller.support.end(),
    ])
      await expect(run()).resolves.toEqual({ reached: true });
    for (const run of [
      () => caller.system.operator(),
      () => caller.system.features(),
      () => caller.system.sendingPaused(),
      () => caller.settings.team.get(),
      () => caller.mailboxes.list(),
      () => caller.mailboxes.items(),
      () => caller.mailboxes.item(),
      () => caller.mailboxes.thread(),
      () => caller.mailboxes.folders(),
    ])
      await expect(run()).resolves.toEqual({ role: "member" });
  });

  it("fails closed for newly added routers, paths and a changed procedure type", async () => {
    const caller = as();
    for (const run of [
      () => caller.futureArea.read(),
      () => caller.futureArea.write(),
      () => caller.mailboxes.futureRead(),
      () => caller.mailboxes.futureWrite(),
    ])
      await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const wrongTypes = createCallerFactory(
      router({
        mailboxes: router({ list: mutation, queueDraft: query }),
        console: router({ users: router({ list: mutation }) }),
      }),
    )({
      db,
      session: { user: { id: USER, name: "Synthetic", email: "synthetic@example.invalid" } },
      teamId,
      role: "member",
    });
    await expect(wrongTypes.mailboxes.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(wrongTypes.mailboxes.queueDraft()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(wrongTypes.console.users.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("reads a profile added after context creation and never trusts its cached role", async () => {
    await db.update(schema.teamMembers).set({ operationsAccess: null }).where(memberWhere());
    const caller = as();
    await expect(caller.billing.checkout()).resolves.toEqual({ reached: true });
    await expect(caller.adminOnly()).rejects.toMatchObject({ code: "FORBIDDEN" });
    effect.mockClear();
    await db.update(schema.teamMembers).set({ operationsAccess: access }).where(memberWhere());
    await expect(caller.billing.checkout()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.mailboxes.list()).resolves.toEqual({ role: "member" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("refuses an unverified, suspended or malformed operational profile", async () => {
    const caller = as();
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, USER));
    await expect(caller.mailboxes.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, USER));
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await expect(caller.mailboxes.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.update(schema.teams).set({ suspendedAt: null }).where(eq(schema.teams.id, teamId));
    await db
      .update(schema.teamMembers)
      .set({ operationsAccess: { ...access, mailboxCreateDomainIds: [DOMAIN, DOMAIN] } })
      .where(memberWhere());
    await expect(caller.mailboxes.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(effect).not.toHaveBeenCalled();
  });

  it("removes team access when a membership is deleted despite an already-created caller", async () => {
    const caller = as();
    await expect(caller.mailboxes.list()).resolves.toEqual({ role: "member" });
    await db.delete(schema.teamMembers).where(memberWhere());
    await expect(caller.mailboxes.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.system.operator()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leaves the same identity's separately owned team on its normal product permissions", async () => {
    const caller = as({ teamId: ownTeamId, role: "member" });
    await expect(caller.billing.checkout()).resolves.toEqual({ reached: true });
    await expect(caller.team.grantTeam()).resolves.toEqual({ reached: true });
    await expect(caller.mailboxes.list()).resolves.toEqual({ role: "owner" });
    await expect(caller.adminOnly()).resolves.toEqual({ reached: true });
  });

  it("does not change the live support-view read-only guard", async () => {
    const caller = as({
      teamId: ownTeamId,
      role: "viewer",
      supportView: {
        grantId: "synthetic-live-support-grant",
        expiresAt: new Date(Date.now() + 1000),
      },
    });
    await expect(caller.billing.checkout()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Read-only support view",
    });
    expect(effect).not.toHaveBeenCalled();
  });
});
