import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let systemTeamId: string;
let freeTeamId: string;
let otherTeamId: string;
let systemFullKey: string;
let systemSendKey: string;
let freeFullKey: string;
let otherFullKey: string;
let systemDomainId: string;

function call(token: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedTeamOwner(teamId: string, email: string) {
  const userId = `user-${randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Owner",
    email,
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({
    teamId,
    userId,
    role: "owner",
  });
}

async function insertKey(
  teamId: string,
  permission: "full_access" | "sending_access" = "full_access",
) {
  const key = generateApiKey();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: `key-${permission}`,
    permission,
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return key.token;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const mail = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
  for (const name of readdirSync(mail)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(mail + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim())) {
        await tx.execute(sql.raw(statement));
      }
    });
  }

  systemTeamId = await createTeam(db, "inboxes-system");
  await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, systemTeamId));
  await seedTeamOwner(systemTeamId, `owner-${randomUUID()}@system.test`);

  freeTeamId = await createTeam(db, "inboxes-free");
  await seedTeamOwner(freeTeamId, `owner-${randomUUID()}@free.test`);

  otherTeamId = await createTeam(db, "inboxes-other");
  await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, otherTeamId));
  await seedTeamOwner(otherTeamId, `owner-${randomUUID()}@other.test`);

  systemFullKey = await insertKey(systemTeamId, "full_access");
  systemSendKey = await insertKey(systemTeamId, "sending_access");
  freeFullKey = await insertKey(freeTeamId, "full_access");
  otherFullKey = await insertKey(otherTeamId, "full_access");

  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId: systemTeamId,
      name: "agents.example.test",
      region: "us-east-1",
      status: "verified",
    })
    .returning({ id: schema.domains.id });
  if (!domain) throw new Error("domain seed failed");
  systemDomainId = domain.id;

  await db.insert(schema.domains).values({
    teamId: freeTeamId,
    name: "free.example.test",
    region: "us-east-1",
    status: "verified",
  });

  app = createApi({
    db,
    keyring: new EnvKeyring(new Map([[1, randomBytes(32)]]), 1),
    isCloud: true,
    enqueueEmailSend: async () => {},
  });
});

afterAll(async () => {
  await close?.();
});

describe("public /inboxes and /v1/inboxes API", () => {
  it("creates, lists, inspects, updates, mints keys, and schedules deletion of an agent inbox", async () => {
    const createRes = await call(systemFullKey, "POST", "/inboxes", {
      local_part: "support-agent",
      domain_id: systemDomainId,
      label: "Support Agent",
      kind: "agent",
      create_key: true,
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      object: string;
      id: string;
      address: string;
      kind: string;
      status: string;
      key: { id: string; token: string; scopes: string[] } | null;
    };
    expect(created.object).toBe("inbox");
    expect(created.address).toBe("support-agent@agents.example.test");
    expect(created.kind).toBe("agent");
    expect(created.status).toBe("planned");
    expect(created.key?.token).toMatch(/^mmb_/);

    // /v1/inboxes alias works identically with full `address` input.
    const aliasRes = await call(systemFullKey, "POST", "/v1/inboxes", {
      address: "triage@agents.example.test",
      create_key: false,
    });
    expect(aliasRes.status).toBe(200);
    const alias = (await aliasRes.json()) as { id: string; address: string; key: null };
    expect(alias.address).toBe("triage@agents.example.test");
    expect(alias.key).toBeNull();

    const listRes = await call(systemFullKey, "GET", "/v1/inboxes");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { id: string }[] };
    expect(listBody.data.map((i) => i.id)).toContain(created.id);
    expect(listBody.data.map((i) => i.id)).toContain(alias.id);

    const getRes = await call(systemFullKey, "GET", `/inboxes/${created.id}`);
    expect(getRes.status).toBe(200);

    // Cross-tenant access returns 404.
    const crossRes = await call(otherFullKey, "GET", `/inboxes/${created.id}`);
    expect(crossRes.status).toBe(404);

    const patchRes = await call(systemFullKey, "PATCH", `/inboxes/${created.id}`, {
      label: "Concierge Bot",
      signature_text: "Sent by Concierge",
    });
    expect(patchRes.status).toBe(200);

    const extraKeyRes = await call(systemFullKey, "POST", `/inboxes/${created.id}/keys`, {
      label: "Readonly worker",
      scopes: ["read"],
    });
    expect(extraKeyRes.status).toBe(200);
    const extraKey = (await extraKeyRes.json()) as { token: string; scopes: string[] };
    expect(extraKey.token).toMatch(/^mmb_/);
    expect(extraKey.scopes).toEqual(["read"]);

    const delRes = await call(systemFullKey, "DELETE", `/inboxes/${created.id}`);
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { deleted: boolean; delete_after: string };
    expect(delBody.deleted).toBe(true);
    expect(Date.parse(delBody.delete_after)).toBeGreaterThan(Date.now());
  });

  it("enforces full_access API key scope and active Mail entitlement", async () => {
    const sendScopeRes = await call(systemSendKey, "POST", "/inboxes", {
      local_part: "blocked",
      domain_id: systemDomainId,
    });
    expect(sendScopeRes.status).toBe(403);

    const noMailPlanRes = await call(freeFullKey, "POST", "/inboxes", {
      local_part: "unlicensed",
      domain: "free.example.test",
    });
    expect(noMailPlanRes.status).toBe(403);
  });
});
