import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { EnvKeyring, generateApiKey, parseSendingProviderPolicy } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reviewedSender } from "../../worker/test/fixtures/antiabuse.js";
import { createSmtpServer, SMTP_USERNAME } from "../src/smtp.js";

// The relay shares POST /emails' restoration sender fence: an unlisted From
// is refused in the SMTP dialogue instead of queueing mail that only parks.
let db: Db;
let closeDb: () => Promise<void>;
let teamId: string;
let token: string;
let port: number;
let server: ReturnType<typeof createSmtpServer>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const enqueued: string[] = [];

const transport = () =>
  nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user: SMTP_USERNAME, pass: token },
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  teamId = await createTeam(db, "smtp-restoration-team");
  await db.insert(schema.domains).values({
    teamId,
    name: "acme.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  await reviewedSender(db, teamId, "acme.dev");
  const key = generateApiKey();
  token = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "smtp",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  server = createSmtpServer({
    db,
    keyring,
    isCloud: true,
    allowInsecureAuth: true,
    sendingProviderPolicy: parseSendingProviderPolicy(
      JSON.stringify({
        version: 1,
        allowedTeamIds: [teamId],
        defaults: { transactional: "disabled", campaign: "disabled" },
        teams: { [teamId]: { transactional: "azure_smtp", campaign: "disabled" } },
        restoration: {
          teams: { [teamId]: { notBefore: "2026-01-01T00:00:00Z", senders: ["a@acme.dev"] } },
        },
      }),
    ),
    enqueueEmailSend: async (emailId: string) => {
      enqueued.push(emailId);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
  await closeDb();
});

describe("smtp relay restoration sender fence", () => {
  it("refuses an unlisted From with 550 and stores nothing", async () => {
    await expect(
      transport().sendMail({
        from: "Acme <billing@acme.dev>",
        to: "r@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toMatchObject({ responseCode: 550 });
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    ).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("accepts a listed From", async () => {
    const info = await transport().sendMail({
      from: "Acme <A@acme.dev>",
      to: "r@example.com",
      subject: "s",
      text: "t",
    });
    expect(info.response).toContain("Queued as");
    expect(enqueued).toHaveLength(1);
  });
});
