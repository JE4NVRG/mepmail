import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import type { SesIdentityClient } from "@millionsend/ses";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syncTenants, watchTenants } from "../src/handlers/tenants.js";

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => {
  vi.restoreAllMocks();
  return close();
});

function fakeSes(failFor: string[] = []) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client: SesIdentityClient = {
    async send(command) {
      const name = command.constructor.name;
      const input = (command as unknown as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (name === "CreateTenantCommand") {
        if (failFor.includes(String(input.TenantName))) {
          throw Object.assign(new Error("throttled"), { name: "TooManyRequestsException" });
        }
        return { TenantArn: `arn:aws:ses:sa-east-1:123456789012:tenant/${input.TenantName}` };
      }
      return {};
    },
  };
  return { client, calls };
}

async function insertDomain(teamId: string, name: string, region = "sa-east-1") {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("insert failed");
  return row.id;
}

it("associates every unmarked domain, stamps it, and names the team's tenant", async () => {
  const teamId = await createTeam(db, "acme");
  const a = await insertDomain(teamId, "a.acme.dev");
  const b = await insertDomain(teamId, "b.acme.dev", "us-east-1");
  const { client, calls } = fakeSes();
  const now = new Date("2026-09-03T12:00:00Z");

  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "mepmail",
      enabled: true,
      now,
    }),
  ).toEqual({ associated: 2, failed: 0 });
  // Per domain: tenant in its region, then identity + configuration set associations.
  expect(calls.map((c) => c.name)).toEqual([
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
  ]);
  expect(calls[1]?.input.ResourceArn).toBe(
    "arn:aws:ses:sa-east-1:123456789012:identity/a.acme.dev",
  );
  expect(calls[2]?.input.ResourceArn).toBe(
    "arn:aws:ses:sa-east-1:123456789012:configuration-set/mepmail",
  );
  for (const id of [a, b]) {
    const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
    expect(row?.sesTenantAssociatedAt).toEqual(now);
    expect(row?.sesTenantConfigSet).toBe("mepmail");
  }
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sesTenantName).toBe(teamId);

  // Nothing left to do on the next run.
  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "mepmail",
      enabled: true,
    }),
  ).toEqual({ associated: 0, failed: 0 });
});

it("re-associates a domain whose recorded configuration set drifted from the env", async () => {
  const teamId = await createTeam(db, "acme");
  const id = await insertDomain(teamId, "a.acme.dev");
  await db
    .update(schema.domains)
    .set({ sesTenantAssociatedAt: new Date("2026-01-01T00:00:00Z"), sesTenantConfigSet: "old" })
    .where(eq(schema.domains.id, id));
  const { client, calls } = fakeSes();
  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "mepmail",
      enabled: true,
    }),
  ).toEqual({ associated: 1, failed: 0 });
  expect(calls.map((c) => c.name)).toEqual([
    "CreateTenantCommand",
    "CreateTenantResourceAssociationCommand",
    "CreateTenantResourceAssociationCommand",
  ]);
  const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, id));
  expect(row?.sesTenantConfigSet).toBe("mepmail");
});

it("one failing domain is logged and skipped; the others still get associated", async () => {
  const bad = await createTeam(db, "bad");
  const good = await createTeam(db, "good");
  await insertDomain(bad, "bad.dev");
  await insertDomain(good, "good.dev");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { client } = fakeSes([bad]);

  expect(await syncTenants(db, { clientForRegion: () => client, enabled: true })).toEqual({
    associated: 1,
    failed: 1,
  });
  expect(warn).toHaveBeenCalledTimes(1);
  const marked = await db
    .select({ name: schema.domains.name })
    .from(schema.domains)
    .where(isNotNull(schema.domains.sesTenantAssociatedAt));
  expect(marked).toEqual([{ name: "good.dev" }]);
});

it("never recreates the tenant of a suspended team, nor touches a failed row", async () => {
  const suspended = await createTeam(db, "phish");
  const live = await createTeam(db, "live");
  await insertDomain(suspended, "phish.example");
  const failed = await insertDomain(live, "broken.example");
  await insertDomain(live, "ok.example");
  await db
    .update(schema.teams)
    .set({ suspendedAt: new Date("2026-10-07T02:41:00Z") })
    .where(eq(schema.teams.id, suspended));
  await db.update(schema.domains).set({ status: "failed" }).where(eq(schema.domains.id, failed));
  const { client, calls } = fakeSes();

  expect(
    await syncTenants(db, {
      clientForRegion: () => client,
      configurationSet: "mepmail",
      enabled: true,
    }),
  ).toEqual({ associated: 1, failed: 0 });
  expect(
    calls.filter((c) => c.name === "CreateTenantCommand").map((c) => c.input.TenantName),
  ).toEqual([live]);
  expect(calls.some((c) => String(c.input.ResourceArn ?? "").includes("phish.example"))).toBe(
    false,
  );
  expect(calls.some((c) => String(c.input.ResourceArn ?? "").includes("broken.example"))).toBe(
    false,
  );
});

it("does nothing when tenants are disabled", async () => {
  await insertDomain(await createTeam(db, "acme"), "a.acme.dev");
  const { client, calls } = fakeSes();
  expect(await syncTenants(db, { clientForRegion: () => client, enabled: false })).toEqual({
    associated: 0,
    failed: 0,
  });
  expect(calls).toEqual([]);
});

function tenantStatusSes(statusFor: Record<string, string | Error>) {
  const asked: string[] = [];
  const client: SesIdentityClient = {
    async send(command) {
      const input = (command as unknown as { input: Record<string, unknown> }).input;
      if (command.constructor.name !== "GetTenantCommand") return {};
      const name = String(input.TenantName);
      asked.push(name);
      const status = statusFor[name];
      if (status instanceof Error) throw status;
      return { Tenant: { TenantName: name, SendingStatus: status ?? "ENABLED" } };
    },
  };
  return { client, asked };
}

it("holds for review a team whose SES tenant SES paused, and leaves sending tenants alone", async () => {
  const paused = await createTeam(db, "paused");
  const fine = await insertTeamWithTenant("fine");
  const broken = await insertTeamWithTenant("broken");
  await insertDomain(paused, "paused.dev");
  await db
    .update(schema.domains)
    .set({ sesTenantAssociatedAt: new Date() })
    .where(eq(schema.domains.teamId, paused));
  const { client, asked } = tenantStatusSes({
    [paused]: "DISABLED",
    [broken]: Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }),
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const result = await watchTenants(db, { clientForRegion: () => client, enabled: true });
  expect(result).toEqual({ checked: 2, held: 1, failed: 1 });
  expect(asked.sort()).toEqual([broken, fine, paused].sort());
  const [held] = await db
    .select({ at: schema.teams.sendReviewAt, reason: schema.teams.sendReviewReason })
    .from(schema.teams)
    .where(eq(schema.teams.id, paused));
  expect(held?.reason).toBe("reputation");
  expect(held?.at).toBeInstanceOf(Date);
  const [ok] = await db
    .select({ at: schema.teams.sendReviewAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, fine));
  expect(ok?.at).toBeNull();

  // Already held: not asked again; off: nothing at all.
  const again = tenantStatusSes({});
  await watchTenants(db, { clientForRegion: () => again.client, enabled: true });
  expect(again.asked).not.toContain(paused);
  const off = tenantStatusSes({});
  expect(await watchTenants(db, { clientForRegion: () => off.client, enabled: false })).toEqual({
    checked: 0,
    held: 0,
    failed: 0,
  });
  expect(off.asked).toEqual([]);
});

async function insertTeamWithTenant(slug: string) {
  const teamId = await createTeam(db, slug);
  await insertDomain(teamId, `${slug}.dev`);
  await db
    .update(schema.domains)
    .set({ sesTenantAssociatedAt: new Date() })
    .where(eq(schema.domains.teamId, teamId));
  return teamId;
}
