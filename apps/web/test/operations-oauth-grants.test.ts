import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { grantClaims } from "@/server/auth";

let db: Db;
let close: () => Promise<void>;
let restrictedTeam: string;
let ownTeam: string;
const userId = "ops-oauth-only-user";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values({
    id: userId,
    name: "Operations test",
    email: "ops-oauth@example.invalid",
    emailVerified: true,
  });
  restrictedTeam = await createTeam(db, "ops-oauth-restricted");
  ownTeam = await createTeam(db, "ops-oauth-owned");
  await db.insert(schema.teamMembers).values([
    {
      userId,
      teamId: restrictedTeam,
      role: "member",
      operationsAccess: { version: 1, userDirectoryRead: true, mailboxCreateDomainIds: [] },
    },
    { userId, teamId: ownTeam, role: "owner" },
  ]);
});

afterEach(async () => close());

it("denies access-token issuance and refresh for the operational team", async () => {
  await expect(grantClaims(db, { id: userId }, restrictedTeam)).rejects.toThrow(
    "This operational profile cannot authorize team-wide integrations.",
  );
});

it("denies all-teams grants if they would include an operational membership", async () => {
  await expect(grantClaims(db, { id: userId }, "*")).rejects.toThrow(
    "This operational profile cannot authorize team-wide integrations.",
  );
});

it("preserves normal grants for a separate team the person owns", async () => {
  await expect(grantClaims(db, { id: userId }, ownTeam)).resolves.toEqual({
    team_id: ownTeam,
    team_role: "owner",
  });
});

it("refuses a missing or foreign reference without sending an invalid UUID to the database", async () => {
  for (const reference of [undefined, "unknown-team"]) {
    await expect(grantClaims(db, { id: userId }, reference)).rejects.toThrow(
      "The grant is not bound to a team you belong to.",
    );
  }
});
