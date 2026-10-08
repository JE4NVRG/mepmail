import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  assertMailboxSignatureEditor,
  createMailboxRegistry,
  listMailboxRegistry,
  setMailboxSignatureLogo,
  updateMailboxSignature,
} from "../src/mailbox-registry.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let mailboxId: string;
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const as = (userId: string) => ({ teamId, userId });
const fields = {
  name: "  Jean   Vargas ",
  title: "Fundador",
  company: "MepMail",
  phone: "+55 (44) 99999-0000",
  website: "mepmail.dev",
  text: "Atendimento 9h-18h\r\nSeg a sex",
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "signature-fixture");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "admin", name: "Admin", email: "admin@example.invalid" },
    { id: "member", name: "Member", email: "member@example.invalid" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "member" },
    { teamId, userId: "admin", role: "admin" },
    { teamId, userId: "member", role: "member" },
  ]);
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 10,
    storageBytesPerMailbox: 5 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 86400000),
  });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.invalid", region: "us-east-1", status: "verified" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, as("admin"), {
      domainId: domain!.id,
      localPart: "jean",
      label: "Jean",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
});
afterEach(async () => {
  await close();
});

it("lets the mailbox owner set a normalized structured signature", async () => {
  const saved = await updateMailboxSignature(db, as("owner"), { mailboxId, ...fields });
  expect(saved.signatureProfile).toEqual({
    version: 1,
    name: "Jean Vargas",
    title: "Fundador",
    company: "MepMail",
    phone: "+55 (44) 99999-0000",
    website: "https://mepmail.dev/",
    logoUrl: null,
    logoWidth: null,
    logoHeight: null,
  });
  expect(saved.signatureText).toBe("Atendimento 9h-18h\nSeg a sex");
  const [box] = (await listMailboxRegistry(db, as("owner"))).mailboxes;
  expect(box!.signatureProfile).toEqual(saved.signatureProfile);
});

it("lets an admin edit any signature but not another member", async () => {
  await expect(
    updateMailboxSignature(db, as("admin"), { mailboxId, ...fields, title: "CEO" }),
  ).resolves.toMatchObject({ signatureProfile: { title: "CEO" } });
  await expect(
    updateMailboxSignature(db, as("member"), { mailboxId, ...fields }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(assertMailboxSignatureEditor(db, as("member"), mailboxId)).rejects.toMatchObject({
    code: "forbidden",
  });
  await expect(assertMailboxSignatureEditor(db, as("owner"), mailboxId)).resolves.toBeUndefined();
  await expect(
    updateMailboxSignature(db, { teamId, userId: "stranger" }, { mailboxId, ...fields }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("rejects scripts in the website, letters in the phone and oversized fields", async () => {
  for (const bad of [
    { website: "javascript:alert(1)" },
    { website: "https://user:pass@example.com" },
    { website: "localhost" },
    { phone: "call me" },
    { name: "x".repeat(81) },
    { company: "line\nbreak" },
  ])
    await expect(
      updateMailboxSignature(db, as("owner"), { mailboxId, ...fields, ...bad }),
    ).rejects.toMatchObject({ code: "invalid" });
});

it("keeps the logo across field edits and clears its size with it", async () => {
  await updateMailboxSignature(db, as("owner"), { mailboxId, ...fields });
  const logo = await setMailboxSignatureLogo(db, as("owner"), {
    mailboxId,
    logoUrl: "https://cdn.example.invalid/signature-logos/t/m.png?v=1",
    width: 480,
    height: 160,
  });
  expect(logo.previous).toBeNull();
  expect(logo.signatureProfile).toMatchObject({ name: "Jean Vargas", logoWidth: 480 });
  const edited = await updateMailboxSignature(db, as("owner"), {
    mailboxId,
    ...fields,
    name: "Jean",
  });
  expect(edited.signatureProfile).toMatchObject({
    name: "Jean",
    logoUrl: "https://cdn.example.invalid/signature-logos/t/m.png?v=1",
    logoHeight: 160,
  });
  const cleared = await setMailboxSignatureLogo(db, as("owner"), { mailboxId, logoUrl: null });
  expect(cleared.previous).toBe("https://cdn.example.invalid/signature-logos/t/m.png?v=1");
  expect(cleared.signatureProfile).toMatchObject({ logoUrl: null, logoWidth: null, name: "Jean" });
  await expect(
    setMailboxSignatureLogo(db, as("owner"), { mailboxId, logoUrl: "javascript:alert(1)" }),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    setMailboxSignatureLogo(db, as("member"), { mailboxId, logoUrl: null }),
  ).rejects.toMatchObject({ code: "forbidden" });
});
