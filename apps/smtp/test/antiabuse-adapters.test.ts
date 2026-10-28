import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createSmtpServer, SMTP_USERNAME } from "../src/smtp.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => {
  await fixture?.close();
});
it.each([true, false])(
  "SMTP real AUTH/DATA campaign consent (cloud=%s), no provider",
  async (isCloud) => {
    const { db } = fixture;
    const teamId = await createTeam(db, randomUUID());
    const domain = `${randomUUID()}.example.test`;
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(Date.now() - 40 * 86400000), sendReviewClearedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.domains).values({
      teamId,
      name: domain,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    });
    const key = generateApiKey();
    await db.insert(schema.apiKeys).values({
      teamId,
      name: "synthetic",
      tokenPrefix: key.tokenPrefix,
      keyHash: key.keyHash,
      last4: key.last4,
    });
    const queued: string[] = [];
    const server = createSmtpServer({
      db,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud,
      allowInsecureAuth: true,
      enqueueEmailSend: async (id) => {
        queued.push(id);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const transport = nodemailer.createTransport({
      host: "127.0.0.1",
      port: (server.server.address() as AddressInfo).port,
      secure: false,
      ignoreTLS: true,
      auth: { user: SMTP_USERNAME, pass: key.token },
    });
    try {
      await transport.verify();
      const send = transport.sendMail({
        from: `service@${domain}`,
        to: "recipient@example.test",
        subject: "Message",
        text: "Course Spotlight. Limited seats. Register for London training.",
      });
      if (isCloud)
        await expect(send).rejects.toMatchObject({
          responseCode: 550,
          response: expect.stringContaining("campaign_consent_required"),
        });
      else expect((await send).response).toContain("Queued as");
      const rows = await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));
      expect(rows).toHaveLength(isCloud ? 0 : 1);
      expect(queued).toHaveLength(isCloud ? 0 : 1);
      const usage = await db
        .select()
        .from(schema.usageCounters)
        .where(eq(schema.usageCounters.teamId, teamId));
      expect(usage).toHaveLength(isCloud ? 0 : 1);
      if (!isCloud) expect(usage[0]?.accepted).toBe(1);
    } finally {
      transport.close();
      await new Promise<void>((resolve) => server.close(resolve));
    }
  },
);
