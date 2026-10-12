import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { EnvKeyring } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMailboxAppPassword,
  deriveMailboxAppPasswordKey,
} from "../../../packages/core/src/mailbox-app-passwords.js";
import { readMailboxItem } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import { createMailboxSubmissionServer, withEnvelopeBcc } from "../src/mailbox-submission.js";
import { mailboxSubmissionMime } from "../src/mailbox-transport-mime.js";

let db: Db;
let closeDb: () => Promise<void>;
let teamId: string;
let mailboxId: string;
let password: string;
let port: number;
let server: ReturnType<typeof createMailboxSubmissionServer>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const passwordKey = deriveMailboxAppPasswordKey(randomBytes(32));
const enqueued: string[] = [];
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));

const transport = (user = "jean@box.test", pass = password) =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user, pass },
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "submission-team");
  await db.insert(schema.user).values({ id: "jean", name: "Jean", email: "jean@example.test" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "jean", role: "owner" });
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
  const actor = { teamId, userId: "jean" };
  mailboxId = (
    await createMailboxRegistry(db, actor, {
      domainId: domain!.id,
      localPart: "jean",
      label: "Jean",
      kind: "person",
      ownerUserId: "jean",
    })
  ).id;
  password = (
    await createMailboxAppPassword(db, passwordKey, actor, { mailboxId, label: "Outlook" })
  ).password;
  server = createMailboxSubmissionServer({
    db,
    keyring,
    passwordKey,
    mime: mailboxSubmissionMime,
    enqueueSend: async (id) => {
      enqueued.push(id);
    },
    transportEnabled: true,
    allowInsecureAuth: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe("SMTP submission with an app password", () => {
  it("sends as the mailbox through the Correio's own admission, Bcc from the envelope", async () => {
    const info = await transport().sendMail({
      from: '"Jean" <jean@box.test>',
      to: "ana@example.test",
      cc: "bruno@example.test",
      bcc: "carla@example.test",
      subject: "Proposta",
      text: "Segue a proposta.",
      messageId: "<proposta-1@outlook.test>",
    });
    expect(info.response).toMatch(/^250 .*Queued as [0-9a-f-]{36}/);
    expect(info.accepted.sort()).toEqual([
      "ana@example.test",
      "bruno@example.test",
      "carla@example.test",
    ]);
    const [outbox] = await db.select().from(schema.mailboxOutbox);
    expect(outbox).toMatchObject({
      mailboxId,
      approvalKind: "human",
      approvedBy: "jean",
      recipientCount: 3,
      status: "queued",
    });
    expect(enqueued).toEqual([outbox!.id]);
    // The draft names every recipient (Bcc too), so the send goes to exactly these.
    const draft = await readMailboxItem(
      db,
      keyring,
      { teamId, userId: "jean" },
      {
        mailboxId,
        id: outbox!.draftId,
      },
    );
    expect(draft.raw.toString()).toMatch(/^Bcc: carla@example\.test$/m);
  });

  it("refuses anything that is not this mailbox, its password or the Correio's limits", async () => {
    await expect(transport("jean@box.test", "aaaa bbbb cccc dddd").verify()).rejects.toMatchObject({
      responseCode: 535,
    });
    await expect(
      transport().sendMail({
        from: "outro@box.test",
        to: "ana@example.test",
        subject: "x",
        text: "x",
      }),
    ).rejects.toMatchObject({ responseCode: 553 });
    await expect(
      transport().sendMail({
        from: "jean@box.test",
        to: Array.from({ length: 21 }, (_, i) => `r${i}@example.test`),
        subject: "x",
        text: "x",
      }),
    ).rejects.toMatchObject({ responseCode: 452 });
    await expect(
      transport().sendMail({
        from: "jean@box.test",
        to: "ana@example.test",
        subject: "Grande",
        text: "x".repeat(1024 * 1024 + 10),
      }),
    ).rejects.toMatchObject({ responseCode: 552 });
    // A header recipient outside RCPT TO would be sent to without the client meaning it.
    await expect(
      transport().sendMail({
        envelope: { from: "jean@box.test", to: ["ana@example.test"] },
        from: "jean@box.test",
        to: ["ana@example.test", "zeca@example.test"],
        subject: "x",
        text: "x",
      }),
    ).rejects.toMatchObject({ responseCode: 554 });
    expect(await db.select().from(schema.mailboxOutbox)).toHaveLength(1);
  });

  it("stops at once when the password is revoked", async () => {
    await db
      .update(schema.mailboxAppPasswords)
      .set({ revokedAt: new Date() })
      .where(eq(schema.mailboxAppPasswords.mailboxId, mailboxId));
    await expect(transport().verify()).rejects.toMatchObject({ responseCode: 535 });
  });
});

describe("withEnvelopeBcc", () => {
  it("replaces the client's Bcc header, folded lines included", () => {
    const raw = Buffer.from(
      "From: a@b.test\r\nBcc: old@x.test,\r\n  other@x.test\r\nTo: c@d.test\r\n\r\nBody\r\nBcc: not-a-header\r\n",
    );
    expect(withEnvelopeBcc(raw, ["new@x.test"]).toString()).toBe(
      "From: a@b.test\r\nTo: c@d.test\r\nBcc: new@x.test\r\n\r\nBody\r\nBcc: not-a-header\r\n",
    );
    expect(withEnvelopeBcc(raw, []).toString()).toBe(
      "From: a@b.test\r\nTo: c@d.test\r\n\r\nBody\r\nBcc: not-a-header\r\n",
    );
  });
});
