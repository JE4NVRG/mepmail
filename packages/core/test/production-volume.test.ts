import { randomUUID } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  approveProductionVolume,
  observeProductionVolume,
  productionVolumeStatus,
} from "../src/production-volume.js";
import { verifiedDns } from "./antiabuse-contract-fixture.js";

let f: Awaited<ReturnType<typeof createTestDb>>;
let operatorId: string;
beforeAll(async () => {
  f = await createTestDb();
  operatorId = randomUUID();
  await f.db.insert(schema.user).values({
    id: operatorId,
    name: "Operator",
    email: `${operatorId}@example.test`,
    emailVerified: true,
    createdAt: new Date(0),
  });
});
afterAll(async () => f.close());
it("self review denied and mandatory audit failure leaves no grant", async () => {
  const teamId = await createTeam(f.db, randomUUID());
  const principalId = randomUUID();
  await f.db.insert(schema.user).values({
    id: principalId,
    name: "Principal",
    email: `${principalId}@example.test`,
    emailVerified: true,
  });
  await f.db.insert(schema.teamSignupRisk).values({
    teamId,
    principalUserId: operatorId,
    level: "good",
    signals: {
      domain: "example.test",
      disposable: false,
      mx: "present",
      domainAgeDays: 100,
      catchAll: "unknown",
      randomLocal: false,
      ipKey: null,
      asn: null,
      signupsIp1h: 0,
      signupsDomain24h: 0,
      signupsAsn1h: 0,
    },
  });
  await f.db
    .update(schema.teams)
    .set({ dailySendCeiling: 4000 })
    .where(eq(schema.teams.id, teamId));
  await f.db.insert(schema.domains).values({
    teamId,
    name: "volume.example.test",
    status: "verified",
    region: "us-east-1",
    ...verifiedDns("volume.example.test"),
    lastCheckedAt: new Date(),
  });
  const input = async () => ({
    teamId,
    operatorId,
    expectedEpoch: (await observeProductionVolume(f.db, teamId)).epoch,
    dailyCeiling: 4000,
    reason: "Synthetic independent volume decision",
    evidenceReference: "fixture-42",
  });
  await expect(approveProductionVolume(f.db, await input())).rejects.toThrow(
    "volume_independent_operator_required",
  );
  const [risk] = await f.db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, teamId));
  if (!risk) throw new Error("missing risk");
  await f.db.delete(schema.teamSignupRisk).where(eq(schema.teamSignupRisk.teamId, teamId));
  await f.db.insert(schema.teamSignupRisk).values({ ...risk, principalUserId: principalId });
  await f.db.execute(
    sql.raw(
      `CREATE FUNCTION reject_volume_audit() RETURNS trigger AS $$ BEGIN IF NEW.action = 'team.production_volume_approved' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;`,
    ),
  );
  await f.db.execute(
    sql.raw(
      "CREATE TRIGGER reject_volume_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_volume_audit()",
    ),
  );
  await expect(approveProductionVolume(f.db, await input())).rejects.toThrow();
  expect((await productionVolumeStatus(f.db, teamId)).ceiling).toBeNull();
});
