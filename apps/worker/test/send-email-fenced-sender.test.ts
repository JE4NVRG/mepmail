import { randomBytes, randomUUID } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  parseSendingProviderPolicy,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";
import { createCustomerSmtpRelay } from "../src/handlers/smtp-fallback.js";

// Regression: a send from a sender outside the team's restoration cohort was
// acked as "parked" while the row stayed "queued" with no event, so it was
// stranded forever (the reconcile applies the same admission and never
// re-enqueues it). It must park visibly as queued_quota instead, stay parked
// while still fenced, and drain once the policy lists the sender.
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let team: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const cutover = new Date(Date.now() - 60_000);
const listed = "allowed@example.invalid";
const unlisted = "not-listed@example.invalid";
const later = "later@example.invalid";

beforeAll(async () => {
  fixture = await createTestDb();
  team = await createTeam(fixture.db, "fenced-sender");
});
afterAll(async () => fixture?.close());

function policy(senders: string[]) {
  return parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [team],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: { [team]: { transactional: "azure_smtp", campaign: "disabled" } },
      restoration: { teams: { [team]: { notBefore: cutover.toISOString(), senders } } },
    }),
  );
}

async function seed(from: string) {
  const id = randomUUID();
  const body = await encryptEmailBody(
    { html: "<p>Your verification code is 123456</p>", text: "Your verification code is 123456" },
    keyring,
    { teamId: team, rowId: id },
  );
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      id,
      teamId: team,
      from,
      to: [`r-${id}@example.invalid`],
      subject: "Your verification code",
      latestStatus: "queued",
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
    })
    .returning();
  if (!email) throw new Error("seed failed");
  return email;
}

function deps(senders: string[]) {
  const ses = vi.fn(async () => ({ messageId: "must-not-send" }));
  const smtp = vi.fn(async (_mail: { envelope: { from: string; to: string[] }; raw: Buffer }) => ({
    messageId: "<acs@example.invalid>",
    response: `250 2.0.0 OK ${randomUUID()}`,
  }));
  const value: SendDeps = {
    keyring,
    unsubscribe: {
      secretKey: deriveUnsubscribeKey(Buffer.alloc(32, 41)),
      baseUrl: "https://optout.example.invalid",
    },
    ses: { sendRaw: ses },
    fallback: { sendRaw: ses },
    relay: {
      name: "azure",
      sender: createCustomerSmtpRelay("smtp://synthetic:fixture@smtp.example.invalid", "azure", {
        sendMail: smtp,
      }),
    },
    sendingProviderPolicy: policy(senders),
  };
  return { value, ses, smtp };
}

async function status(id: string) {
  const [row] = await fixture.db
    .select({ status: schema.emails.latestStatus, sentAt: schema.emails.sentAt })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  return row;
}

describe("restoration sender fence in the send lane", () => {
  it("parks an unlisted From as queued_quota without any transport call", async () => {
    const email = await seed(`Elozi <${unlisted}>`);
    const d = deps([listed]);
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
    expect(d.smtp).not.toHaveBeenCalled();
    expect(d.ses).not.toHaveBeenCalled();
    // Before the fix this stayed "queued": acked job, no transition, stranded.
    expect(await status(email.id)).toEqual({ status: "queued_quota", sentAt: null });
  });

  it("still routes a listed sender (case-insensitive) through the cohort transport", async () => {
    const email = await seed("Elozi <Allowed@Example.invalid>");
    const d = deps([listed]);
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("sent");
    expect(d.smtp).toHaveBeenCalledTimes(1);
    expect(d.ses).not.toHaveBeenCalled();
  });

  it("keeps the parked row parked while fenced and drains it once the sender is listed", async () => {
    const email = await seed(later);
    expect(await sendEmail(fixture.db, deps([listed]).value, { emailId: email.id })).toBe("parked");
    expect((await status(email.id))?.status).toBe("queued_quota");

    // Still fenced: the drain neither moves nor enqueues it (no thrash).
    const fencedEnqueue = vi.fn(async () => {});
    await drainQuotaParked(fixture.db, {
      isCloud: false,
      enqueueSends: fencedEnqueue,
      queueAdmission: { policy: policy([listed]), azureAvailable: true },
    });
    expect(fencedEnqueue).not.toHaveBeenCalled();
    expect((await status(email.id))?.status).toBe("queued_quota");

    // Operator lists the sender: the drain releases it (and only it; the other
    // unlisted sender's parked row stays parked) to the send lane.
    const admitted = policy([listed, later]);
    const enqueue = vi.fn(async (_rows: { emailId: string }[]) => {});
    await drainQuotaParked(fixture.db, {
      isCloud: false,
      enqueueSends: enqueue,
      queueAdmission: { policy: admitted, azureAvailable: true },
    });
    expect(enqueue.mock.calls.flatMap(([rows]) => rows.map((r) => r.emailId))).toEqual([email.id]);
    expect((await status(email.id))?.status).toBe("queued");
    const d = deps([listed, later]);
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("sent");
    expect(d.smtp).toHaveBeenCalledTimes(1);
  });
});
