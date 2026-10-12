import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appendMailboxActivity,
  createMailboxAgentKey,
  createMailboxRegistry,
  EnvKeyring,
  saveMailboxDraft,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
vi.mock("@/server/keyring", () => ({ getKeyring: () => keys }));

const { getMailboxAgentsOverview } = await import("@/server/mailbox-agents-overview");

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let mailboxId: string;
let keyId: string;
let draftId: string;
let membershipId: string;
const owner = () => ({ teamId, userId: "owner" });
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "agents-panel");
  await db.insert(schema.user).values({ id: "owner", name: "Jean", email: "jean@example.test" });
  const [member] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId: "owner", role: "owner" })
    .returning();
  membershipId = member!.id;
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.test", region: "us-east-1", status: "verified" })
    .returning();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 3,
    storageBytesPerMailbox: 50 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 29 * 86400000),
  });
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domain!.id,
      localPart: "vendas",
      label: "Vendas",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  keyId = (
    await createMailboxAgentKey(db, owner(), {
      mailboxId,
      label: "Sage",
      scopes: ["read", "draft"],
    })
  ).id;
  const draft = await saveMailboxDraft(db, keys, owner(), {
    mailboxId,
    expectedRevision: 0,
    raw: Buffer.from(
      [
        "From: vendas@box.test",
        "To: cliente@example.test",
        "Cc: gerente@example.test",
        "Bcc: arquivo@example.test",
        "Subject: Proposta revisada",
        "",
        "Segue a proposta revisada com o desconto combinado.",
      ].join("\r\n"),
    ),
  });
  draftId = draft.id;
  // The agent (no send permission) asked the owner to send this revision.
  await db.transaction(async (tx) =>
    appendMailboxActivity(
      tx as unknown as Db,
      { teamId, mailboxId, actor: { kind: "mailbox_agent", keyId } },
      { action: "mailbox.send_requested", itemId: draftId, revision: draft.revision },
    ),
  );
});
afterAll(async () => close());

describe("agents panel overview", () => {
  it("shows what waits for approval with every recipient, the agent and what it did", async () => {
    const overview = await getMailboxAgentsOverview(db, owner());
    expect(overview.approvals).toEqual([
      expect.objectContaining({
        mailboxId,
        address: "vendas@box.test",
        itemId: draftId,
        agentLabel: "Sage",
        subject: "Proposta revisada",
        to: ["cliente@example.test"],
        cc: ["gerente@example.test"],
        bcc: ["arquivo@example.test"],
        preview: "Segue a proposta revisada com o desconto combinado.",
      }),
    ]);
    expect(overview.credentials).toEqual([
      expect.objectContaining({
        credentialId: keyId,
        kind: "mailbox",
        label: "Sage",
        scopes: ["read", "draft"],
        mailboxes: [{ mailboxId, address: "vendas@box.test" }],
      }),
    ]);
    expect(overview.activity).toEqual([
      expect.objectContaining({
        action: "mailbox.send_requested",
        agentLabel: "Sage",
        itemId: draftId,
      }),
    ]);
  });

  it("drops a request once that revision is sent", async () => {
    await db.insert(schema.mailboxOutbox).values({
      teamId,
      mailboxId,
      draftId,
      draftRevision: 1,
      approvedBy: "owner",
      approvedMembershipId: membershipId,
      recipientCount: 3,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 29 * 86400000),
      rawBytes: 1,
      rawSha256: createHash("sha256").update("x").digest("hex"),
      status: "accepted",
      providerMessageId: "fixture",
      acceptedAt: new Date(),
      attemptId: randomUUID(),
      attemptedAt: new Date(),
    });
    expect((await getMailboxAgentsOverview(db, owner())).approvals).toEqual([]);
  });

  it("is empty for someone who owns no mailbox", async () => {
    await db
      .insert(schema.user)
      .values({ id: "colleague", name: "Ana", email: "ana@example.test" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "colleague", role: "member" });
    expect(await getMailboxAgentsOverview(db, { teamId, userId: "colleague" })).toEqual({
      mailboxes: [],
      credentials: [],
      approvals: [],
      activity: [],
    });
  });
});
