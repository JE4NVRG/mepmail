import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UsersList } from "@/components/console/users/types";
import type { TeamRole } from "@/server/membership";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;
let teamId: string;

// Registration order is what makes the first one the instance operator.
const OPERATOR = "op";
const OWNER = "ana";
const LONER = "lone";
const LATER = "later";

const DAY_MS = 86_400_000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    {
      id: OPERATOR,
      name: "Operator",
      email: "op@example.com",
      emailVerified: true,
      createdAt: new Date(0),
    },
    {
      id: OWNER,
      name: "Ana Owner",
      email: "ana@example.com",
      emailVerified: false,
      createdAt: new Date(1000),
    },
    {
      id: LONER,
      name: "Lone Wolf",
      email: "lone@example.com",
      emailVerified: true,
      createdAt: new Date(2000),
    },
    {
      id: LATER,
      name: "Later User",
      email: "later@example.com",
      emailVerified: true,
      createdAt: new Date(3000),
    },
  ]);
  teamId = await createTeam(db, "acme");
  await db.insert(schema.teamMembers).values({ teamId, userId: OWNER, role: "owner" });
  await db.insert(schema.teamStandings).values({ teamId, sent30d: 1200, guardrail: "ok" });
  // Two sign-ins: the newest one is the "last sign-in" the list shows.
  await db.insert(schema.session).values([
    {
      id: "s-1",
      userId: OWNER,
      token: "tok-1",
      expiresAt: new Date(Date.now() + DAY_MS),
      createdAt: new Date(5000),
    },
    {
      id: "s-2",
      userId: OWNER,
      token: "tok-2",
      expiresAt: new Date(Date.now() + DAY_MS),
      createdAt: new Date(9000),
    },
  ]);
});
afterAll(() => close());

function callerFor(
  userId: string | null,
  team: string | null = null,
  role: TeamRole | null = null,
) {
  return createCaller({
    db,
    session: userId
      ? {
          user: { id: userId, email: `${userId}@example.com`, name: userId },
          session: { id: `s-${userId}`, createdAt: new Date() },
        }
      : null,
    teamId: team,
    role,
  });
}

const operator = () => callerFor(OPERATOR);
const member = () => callerFor(LATER, teamId, "owner");

function row(page: UsersList, id: string) {
  const found = page.items.find((item) => item.id === id);
  if (!found) throw new Error(`user ${id} missing from the list`);
  return found;
}

describe("console.users.list", () => {
  it("lists every user with their teams, their sends and their last sign-in", async () => {
    const page = await operator().console.users.list({});
    // Newest registration first, by default.
    expect(page.items.map((item) => item.id)).toEqual([LATER, LONER, OWNER, OPERATOR]);
    expect(page.total).toBe(4);
    expect(page.verified).toBe(3);
    expect(page.operatorId).toBe(OPERATOR);
    expect(page.nextOffset).toBeNull();

    const ana = row(page, OWNER);
    expect(ana).toMatchObject({
      name: "Ana Owner",
      email: "ana@example.com",
      emailVerified: false,
      teams: 1,
      ownsTeams: 1,
      teamNames: ["acme"],
      sent30d: 1200,
      isOperator: false,
    });
    expect(ana.lastSeenAt).toBeInstanceOf(Date);
    expect(ana.lastSeenAt?.getTime()).toBe(9000);

    // A user with no team reads zeros and no sign-in, never null figures.
    expect(row(page, LONER)).toMatchObject({
      teams: 0,
      ownsTeams: 0,
      teamNames: [],
      sent30d: 0,
      lastSeenAt: null,
    });
    // The first registered user is flagged as the operator.
    expect(row(page, OPERATOR).isOperator).toBe(true);
    // No secret ever leaves the console: the row carries no account, key or password column.
    expect(Object.keys(ana).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "isOperator",
      "lastSeenAt",
      "name",
      "ownsTeams",
      "sent30d",
      "teamNames",
      "teams",
    ]);
  });

  it("searches by name, e-mail and id, and filters on the verified flag", async () => {
    const byName = await operator().console.users.list({ search: "wolf" });
    expect(byName.items.map((i) => i.id)).toEqual([LONER]);

    const byEmail = await operator().console.users.list({ search: "ana@example" });
    expect(byEmail.items.map((i) => i.id)).toEqual([OWNER]);

    const byId = await operator().console.users.list({ search: OPERATOR });
    expect(byId.items.map((i) => i.id)).toEqual([OPERATOR]);

    // A LIKE metacharacter matches literally: nobody has a "%" in their name.
    const wildcard = await operator().console.users.list({ search: "%" });
    expect(wildcard.items).toHaveLength(0);
    expect(wildcard.total).toBe(0);

    const unverified = await operator().console.users.list({ verified: "no" });
    expect(unverified.items.map((i) => i.id)).toEqual([OWNER]);
    // The counters follow the filter, not the whole instance.
    expect(unverified.total).toBe(1);
    expect(unverified.verified).toBe(0);

    const verified = await operator().console.users.list({ verified: "yes" });
    expect(verified.items.map((i) => i.id)).toEqual([LATER, LONER, OPERATOR]);
    expect(verified.total).toBe(3);
    expect(verified.verified).toBe(3);
  });

  it("sorts on the aggregates and pages by offset", async () => {
    const byName = await operator().console.users.list({ sort: "name", dir: "asc" });
    expect(byName.items.map((i) => i.id)).toEqual([OWNER, LATER, LONER, OPERATOR]);

    const byTeams = await operator().console.users.list({ sort: "teams", dir: "desc" });
    expect(byTeams.items[0]?.id).toBe(OWNER);

    const bySends = await operator().console.users.list({ sort: "sent30d", dir: "desc" });
    expect(bySends.items[0]).toMatchObject({ id: OWNER, sent30d: 1200 });

    const page1 = await operator().console.users.list({ limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual([LATER, LONER]);
    expect(page1.nextOffset).toBe(2);
    const page2 = await operator().console.users.list({ limit: 2, offset: 2 });
    expect(page2.items.map((i) => i.id)).toEqual([OWNER, OPERATOR]);
    expect(page2.nextOffset).toBeNull();
    // The total is the whole filtered set, not the page.
    expect(page2.total).toBe(4);
  });

  it("is operator-only", async () => {
    await expect(member().console.users.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(null).console.users.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
