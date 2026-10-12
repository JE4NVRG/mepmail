import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMailboxAlias } from "../src/mailbox-aliases.js";
import {
  authenticateMailboxAppPassword,
  createMailboxAppPassword,
  deriveMailboxAppPasswordKey,
  listMailboxAppPasswords,
  MAILBOX_APP_PASSWORD_LIMIT,
  mailboxAppPasswordActive,
  normalizeMailboxAppPassword,
  revokeMailboxAppPassword,
} from "../src/mailbox-app-passwords.js";
import { requestMailboxDeletion } from "../src/mailbox-deletion.js";
import { createMailboxRegistry, updateMailboxRegistry } from "../src/mailbox-registry.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let person: string;
let agent: string;
const key = deriveMailboxAppPasswordKey(randomBytes(32));
const owner = () => ({ teamId, userId: "owner" });
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const signIn = (username: string, password: string) =>
  authenticateMailboxAppPassword(db, key, { username, password });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "app-password-fixture");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "colleague", name: "Colleague", email: "colleague@example.invalid" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "colleague", role: "admin" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.invalid", region: "us-east-1", status: "verified" })
    .returning();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 5,
    storageBytesPerMailbox: 50 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 29 * 86400000),
  });
  const box = async (localPart: string, kind: "person" | "agent") =>
    (
      await createMailboxRegistry(db, owner(), {
        domainId: domain!.id,
        localPart,
        label: localPart,
        kind,
        ownerUserId: "owner",
      })
    ).id;
  person = await box("jean", "person");
  agent = await box("bot", "agent");
});
afterEach(async () => {
  await close();
});

describe("app passwords", () => {
  it("are shown once, kept as a hash, and sign in with the address or an alias", async () => {
    const made = await createMailboxAppPassword(db, key, owner(), {
      mailboxId: person,
      label: "  Outlook   do notebook ",
    });
    expect(made.password).toMatch(/^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/);
    expect(made.label).toBe("Outlook do notebook");
    expect(made.hint).toBe(made.password.slice(-4));
    const [stored] = await db.select().from(schema.mailboxAppPasswords);
    expect(stored?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(made.password.replace(/ /g, ""));
    expect(await listMailboxAppPasswords(db, owner(), person)).toEqual([
      expect.objectContaining({ id: made.id, label: "Outlook do notebook", lastUsedAt: null }),
    ]);

    // Typed with or without spaces, in capitals: the same password.
    const identity = await signIn("Jean@Box.invalid", made.password.toUpperCase());
    expect(identity).toEqual({
      passwordId: made.id,
      teamId,
      mailboxId: person,
      userId: "owner",
      address: "jean@box.invalid",
    });
    expect((await listMailboxAppPasswords(db, owner(), person))[0]?.lastUsedAt).toBeInstanceOf(
      Date,
    );
    await addMailboxAlias(db, owner(), { mailboxId: person, localPart: "contato" });
    expect(await signIn("contato@box.invalid", made.password.replace(/ /g, "-"))).toMatchObject({
      mailboxId: person,
    });
    // Nothing else signs in, and nothing tells which part was wrong.
    expect(await signIn("bot@box.invalid", made.password)).toBeNull();
    expect(await signIn("jean@box.invalid", "aaaa bbbb cccc dddd")).toBeNull();
    expect(await signIn("jean@box.invalid", "")).toBeNull();
    expect(normalizeMailboxAppPassword("abcd efgh ijkl mnop")).toBeNull(); // i and l are not in it
  });

  it("only the owner's person mailbox gets them, up to the limit", async () => {
    await expect(
      createMailboxAppPassword(
        db,
        key,
        { teamId, userId: "colleague" },
        { mailboxId: person, label: "x" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createMailboxAppPassword(db, key, owner(), { mailboxId: agent, label: "x" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      createMailboxAppPassword(db, key, owner(), { mailboxId: person, label: "   " }),
    ).rejects.toMatchObject({ code: "invalid" });
    for (let i = 0; i < MAILBOX_APP_PASSWORD_LIMIT; i++)
      await createMailboxAppPassword(db, key, owner(), { mailboxId: person, label: `App ${i}` });
    await expect(
      createMailboxAppPassword(db, key, owner(), { mailboxId: person, label: "One more" }),
    ).rejects.toMatchObject({ code: "quota" });
  });

  it("stop working when revoked, when the owner changes and when the mailbox stops", async () => {
    const first = await createMailboxAppPassword(db, key, owner(), {
      mailboxId: person,
      label: "A",
    });
    const second = await createMailboxAppPassword(db, key, owner(), {
      mailboxId: person,
      label: "B",
    });
    const identity = await signIn("jean@box.invalid", first.password);
    expect(identity).not.toBeNull();

    await revokeMailboxAppPassword(db, owner(), { mailboxId: person, id: first.id });
    expect(await signIn("jean@box.invalid", first.password)).toBeNull();
    expect(await mailboxAppPasswordActive(db, identity!)).toBe(false);
    await expect(
      revokeMailboxAppPassword(db, owner(), { mailboxId: person, id: first.id }),
    ).rejects.toMatchObject({ code: "not_found" });

    await updateMailboxRegistry(db, owner(), {
      id: person,
      label: "jean",
      ownerUserId: "owner",
      status: "suspended",
    });
    expect(await signIn("jean@box.invalid", second.password)).toBeNull();
    await updateMailboxRegistry(db, owner(), {
      id: person,
      label: "jean",
      ownerUserId: "owner",
      status: "planned",
    });
    expect(await signIn("jean@box.invalid", second.password)).not.toBeNull();

    // A new owner: the old owner's passwords no longer open it.
    await updateMailboxRegistry(db, owner(), {
      id: person,
      label: "jean",
      ownerUserId: "colleague",
      status: "planned",
    });
    expect(await signIn("jean@box.invalid", second.password)).toBeNull();
    await updateMailboxRegistry(db, owner(), {
      id: person,
      label: "jean",
      ownerUserId: "owner",
      status: "planned",
    });

    // A mailbox being deleted signs nobody in; the row goes with the purge (cascade).
    await requestMailboxDeletion(db, owner(), { id: person, address: "jean@box.invalid" });
    expect(await signIn("jean@box.invalid", second.password)).toBeNull();
    expect(
      await db
        .select()
        .from(schema.mailboxAppPasswords)
        .where(eq(schema.mailboxAppPasswords.id, second.id)),
    ).toHaveLength(1);
  });
});
