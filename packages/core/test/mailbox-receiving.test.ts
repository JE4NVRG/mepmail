import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMailboxReceivingReadiness,
  type MailboxReceivingDeps,
  type MailboxReceivingObservation,
} from "../src/mailbox-receiving.js";
import { createMailboxRegistry } from "../src/mailbox-registry.js";

let client: PGlite;
let db: Db;
const operatorId = randomUUID();
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}
beforeAll(async () => {
  client = new PGlite();
  for (const folder of ["../../db/drizzle/", "../../db/mailbox-drizzle/"]) {
    const path = fileURLToPath(new URL(folder, import.meta.url));
    for (const name of readdirSync(path)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8").split("--> statement-breakpoint"))
          if (statement.trim()) await tx.exec(statement);
      });
  }
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.user).values({
    id: operatorId,
    name: "Platform operator",
    email: `${operatorId}@example.invalid`,
    emailVerified: true,
    createdAt: new Date("2000-01-01T00:00:00Z"),
  });
}, 30000);
afterAll(async () => {
  await client.close();
});

async function fixture(options: { system?: boolean; count?: number; seats?: number } = {}) {
  const id = randomUUID();
  const userId = options.system ? operatorId : id;
  if (!options.system)
    await db.insert(schema.user).values({
      id: userId,
      name: "Mailbox owner",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
  const [team] = await db
    .insert(schema.teams)
    .values({
      name: "Receiving fixture",
      slug: id,
      plan: options.system ? "system" : "free",
    })
    .returning();
  const teamId = required(team).id;
  const [owner] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId, role: "owner" })
    .returning();
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${id}.example.invalid`,
      region: "us-east-1",
      status: "verified",
    })
    .returning();
  const now = new Date();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: options.seats ?? 2,
    storageBytesPerMailbox: 1048576,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(now.getTime() - 3600000),
    periodEnd: new Date(now.getTime() + 3600000),
  });
  const boxes = [];
  for (let i = 0; i < (options.count ?? 1); i++) {
    const [box] = await db
      .insert(schema.mailboxes)
      .values({
        teamId,
        domainId: required(domain).id,
        address: `box${i}@${required(domain).name}`,
        label: `Box ${i}`,
        kind: i % 2 ? "agent" : "person",
        ownerUserId: userId,
        ownerMembershipId: required(owner).id,
        createdAt: new Date(now.getTime() + i),
      })
      .returning();
    boxes.push(required(box));
  }
  const observation: MailboxReceivingObservation = {
    domainId: required(domain).id,
    teamId,
    domainName: required(domain).name,
    region: required(domain).region,
    checkedAt: now,
    ruleSetActive: true,
    ruleEnabled: true,
    tlsRequired: true,
    scanEnabled: true,
    storageReady: true,
    notificationReady: true,
    recipients: boxes.map((box) => box.address),
  };
  const config = { mxExchange: "inbound-smtp.us-east-1.amazonaws.com", ingressEnabled: true };
  const deps: MailboxReceivingDeps = {
    configuration: vi.fn(() => config),
    resolveMx: vi.fn(async () => [{ exchange: config.mxExchange, priority: 10 }]),
    observe: vi.fn(async () => observation),
    now: () => now,
  };
  return {
    actor: { teamId, userId },
    domain: required(domain),
    owner: required(owner),
    boxes,
    now,
    observation,
    config,
    deps,
    read: () => getMailboxReceivingReadiness(db, { teamId, userId }, required(domain).id, deps),
  };
}

describe("fresh domain receiving readiness", () => {
  it("requires receiving MX and exact live rule facts; does not persist ready", async () => {
    const f = await fixture({ count: 2 });
    const dto = await f.read();
    expect(dto.receiving_state).toBe("ready");
    expect(dto.mx).toEqual({
      type: "MX",
      name: f.domain.name,
      value: f.config.mxExchange,
      priority: 10,
      status: "ready",
    });
    expect(dto.mailboxes.map((box) => box.receiving_state)).toEqual(["ready", "ready"]);
    expect(JSON.stringify(dto)).not.toMatch(/ruleSetActive|recipients|bucket|topic|credential/);
    const [box] = await db
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, required(f.boxes[0]).id));
    expect(required(box).status).toBe("planned");
    const [domain] = await db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.id, f.domain.id));
    expect(required(domain).status).toBe("verified");
  });

  it("keeps reservation possible before DNS or receiving configuration exists", async () => {
    const f = await fixture();
    f.deps.configuration = vi.fn(() => null);
    const dto = await f.read();
    expect(dto.receiving_state).toBe("unknown");
    expect(dto.mx.value).toBeNull();
    expect(f.deps.resolveMx).not.toHaveBeenCalled();
    expect(f.deps.observe).not.toHaveBeenCalled();
    const row = await createMailboxRegistry(db, f.actor, {
      domainId: f.domain.id,
      localPart: "new-agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: f.actor.userId,
    });
    expect(row.status).toBe("planned");
  });

  it.each([
    { records: [], status: "missing", reason: "mx_missing" },
    {
      records: [{ exchange: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }],
      status: "conflict",
      reason: "mx_conflict",
    },
    {
      records: [
        { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
        { exchange: "old-provider.example.invalid", priority: 20 },
      ],
      status: "conflict",
      reason: "mx_conflict",
    },
    {
      records: [{ exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: -1 }],
      status: "conflict",
      reason: "mx_conflict",
    },
  ])(
    "does not confuse MAIL FROM or competing records with receiving MX ($reason)",
    async ({ records, status, reason }) => {
      const f = await fixture();
      f.deps.resolveMx = vi.fn(async () => records);
      const dto = await f.read();
      expect(dto.receiving_state).toBe("needs_mx");
      expect(dto.mx.status).toBe(status);
      expect(dto.reasons).toContain(reason);
      expect(dto.mailboxes[0]?.receiving_state).toBe("reserved");
    },
  );

  it("accepts canonical DNS hostname case and trailing dot", async () => {
    const f = await fixture();
    f.deps.resolveMx = vi.fn(async () => [
      { exchange: "INBOUND-SMTP.US-EAST-1.AMAZONAWS.COM.", priority: 10 },
    ]);
    expect((await f.read()).receiving_state).toBe("ready");
  });

  it.each([
    "ruleSetActive",
    "ruleEnabled",
    "tlsRequired",
    "scanEnabled",
    "storageReady",
    "notificationReady",
  ] as const)("fails closed when provider %s is false", async (key) => {
    const f = await fixture();
    f.observation[key] = false;
    const dto = await f.read();
    expect(dto.receiving_state).toBe("needs_activation");
    expect(dto.mailboxes[0]?.receiving_state).toBe("reserved");
  });

  it("does not claim readiness from a global transport switch", async () => {
    const f = await fixture();
    f.config.ingressEnabled = false;
    expect((await f.read()).reasons).toContain("ingress_disabled");
    expect((await f.read()).receiving_state).toBe("needs_activation");
  });

  it.each([
    "stale",
    "future",
    "foreign_team",
    "foreign_domain",
    "foreign_region",
    "catch_all",
    "missing_recipient",
  ])("rejects incomplete or mismatched provider evidence (%s)", async (kind) => {
    const f = await fixture();
    if (kind === "stale") f.observation.checkedAt = new Date(f.now.getTime() - 30001);
    if (kind === "future") f.observation.checkedAt = new Date(f.now.getTime() + 1);
    if (kind === "foreign_team") f.observation.teamId = randomUUID();
    if (kind === "foreign_domain") f.observation.domainId = randomUUID();
    if (kind === "foreign_region") f.observation.region = "eu-west-1";
    if (kind === "catch_all") f.observation.recipients = [f.domain.name];
    if (kind === "missing_recipient") f.observation.recipients = [`someone-else@${f.domain.name}`];
    const dto = await f.read();
    expect(dto.mailboxes[0]?.receiving_state).toBe("reserved");
    if (kind !== "missing_recipient") expect(dto.receiving_state).not.toBe("ready");
  });

  it("does not turn DNS or provider failures into activation success", async () => {
    const f = await fixture();
    f.deps.resolveMx = vi.fn(async () => {
      throw new Error("DNS unavailable");
    });
    f.deps.observe = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });
    const dto = await f.read();
    expect(dto.receiving_state).toBe("unknown");
    expect(dto.reasons).toEqual(
      expect.arrayContaining(["dns_unavailable", "provider_unavailable"]),
    );
  });

  it("bounds freshness policy instead of accepting arbitrarily old proof", async () => {
    const f = await fixture();
    f.deps.maxAgeMs = 60001;
    await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    expect(f.deps.observe).not.toHaveBeenCalled();
  });

  it("excludes a foreign domain before any DNS/provider lookup", async () => {
    const f = await fixture(),
      foreign = await fixture();
    await expect(
      getMailboxReceivingReadiness(db, f.actor, foreign.domain.id, f.deps),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.deps.resolveMx).not.toHaveBeenCalled();
    expect(f.deps.observe).not.toHaveBeenCalled();
  });

  it("restricts the DTO to current administrators and rechecks revocation after lookup", async () => {
    const f = await fixture();
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.id, f.owner.id));
    await expect(f.read()).rejects.toMatchObject({ code: "forbidden" });
    expect(f.deps.observe).not.toHaveBeenCalled();
    await db
      .update(schema.teamMembers)
      .set({ role: "owner" })
      .where(eq(schema.teamMembers.id, f.owner.id));
    f.deps.observe = vi.fn(async () => {
      await db
        .update(schema.teamMembers)
        .set({ role: "member" })
        .where(eq(schema.teamMembers.id, f.owner.id));
      return f.observation;
    });
    await expect(f.read()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects state changes during external observation rather than reusing stale facts", async () => {
    const f = await fixture();
    f.deps.observe = vi.fn(async () => {
      await db
        .update(schema.mailboxes)
        .set({ status: "suspended" })
        .where(eq(schema.mailboxes.id, required(f.boxes[0]).id));
      return f.observation;
    });
    const dto = await f.read();
    expect(dto.receiving_state).toBe("unknown");
    expect(dto.reasons).toContain("state_changed");
    expect(dto.mailboxes[0]?.receiving_state).toBe("suspended");
  });

  it("keeps finite paid allocation and current owners even when SES accepts more recipients", async () => {
    const f = await fixture({ count: 3, seats: 2 });
    let dto = await f.read();
    expect(dto.mailboxes.map((box) => box.receiving_state)).toEqual(["ready", "ready", "reserved"]);
    expect(dto.mailboxes[2]?.reasons).toContain("seat_not_licensed");
    await db
      .update(schema.mailboxes)
      .set({ ownerMembershipId: null })
      .where(eq(schema.mailboxes.id, required(f.boxes[0]).id));
    dto = await f.read();
    expect(dto.mailboxes[0]?.reasons).toContain("owner_inactive");
    expect(dto.mailboxes[0]?.receiving_state).toBe("reserved");
  });

  it("keeps System unlimited in quantity and preserves its finite resource policy", async () => {
    const f = await fixture({ system: true, count: 3 });
    const dto = await f.read();
    expect(dto.mailboxes.map((box) => box.receiving_state)).toEqual(["ready", "ready", "ready"]);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ periodEnd: new Date(Date.now() - 1000) })
      .where(eq(schema.mailboxSubscriptions.teamId, f.actor.teamId));
    const expired = await f.read();
    expect(expired.receiving_state).toBe("needs_activation");
    expect(expired.reasons).toContain("resource_policy_inactive");
    expect(expired.mailboxes.every((box) => box.receiving_state === "reserved")).toBe(true);
    const [policy] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, f.actor.teamId));
    expect(required(policy).seats).toBe(2);
    expect(required(policy).storageBytesPerMailbox).toBe(1048576);
  });
});
