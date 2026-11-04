import { randomBytes, randomUUID } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  parseSendingProviderPolicy,
  utcDay,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";
import { createCustomerSmtpRelay } from "../src/handlers/smtp-fallback.js";

// Regression: a row admitted as transactional (preliminary route selected the
// restoration cohort's transport) whose content the final route classifies as
// campaign was acked "parked" while left "queued" with no event and its
// reservation held: stranded, since the drain re-applies the same admission.
// Under restoration it must be refused: failed, with the hold reason recorded
// and the reservation handed back. Without restoration it still parks.
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let team: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const cutover = new Date(Date.now() - 60_000);
const listed = "donotreply@example.invalid";

beforeAll(async () => {
  fixture = await createTestDb();
  team = await createTeam(fixture.db, "held-after-admission");
});
afterAll(async () => fixture?.close());

function policy(restoration: boolean) {
  return parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [team],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: {
        [team]: { transactional: restoration ? "azure_smtp" : "ses", campaign: "disabled" },
      },
      ...(restoration
        ? {
            restoration: {
              teams: { [team]: { notBefore: cutover.toISOString(), senders: [listed] } },
            },
          }
        : {}),
    }),
  );
}

async function seed(to: string[], domainId: string | null = null) {
  const id = randomUUID();
  // Campaign by content only: nothing the preliminary route can see.
  const body = await encryptEmailBody(
    { html: "<p>Our monthly newsletter is here</p>", text: "Our monthly newsletter is here" },
    keyring,
    { teamId: team, rowId: id },
  );
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      id,
      teamId: team,
      from: `Our Product <${listed}>`,
      to,
      domainId,
      subject: "News",
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

function deps(restoration: boolean) {
  const ses = vi.fn(async () => ({ messageId: "must-not-send" }));
  const smtp = vi.fn(async (_mail: { envelope: { from: string; to: string[] }; raw: Buffer }) => ({
    messageId: "<acs@example.invalid>",
    response: `250 2.0.0 OK ${randomUUID()}`,
  }));
  const value: SendDeps = {
    keyring,
    unsubscribe: {
      secretKey: deriveUnsubscribeKey(Buffer.alloc(32, 43)),
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
    sendingProviderPolicy: policy(restoration),
  };
  return { value, ses, smtp };
}

async function setAccepted(accepted: number) {
  await fixture.db
    .insert(schema.usageCounters)
    .values({ teamId: team, day: utcDay(Date.now()), accepted })
    .onConflictDoUpdate({
      target: [schema.usageCounters.teamId, schema.usageCounters.day],
      set: { accepted },
    });
}

async function accepted() {
  const [row] = await fixture.db
    .select({ accepted: schema.usageCounters.accepted })
    .from(schema.usageCounters)
    .where(
      and(eq(schema.usageCounters.teamId, team), eq(schema.usageCounters.day, utcDay(Date.now()))),
    );
  return row?.accepted;
}

async function stored(id: string) {
  const [row] = await fixture.db
    .select({ status: schema.emails.latestStatus, sentAt: schema.emails.sentAt })
    .from(schema.emails)
    .where(eq(schema.emails.id, id));
  const events = await fixture.db
    .select({ type: schema.emailEvents.type, data: schema.emailEvents.data })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.emailId, id));
  return { row, events };
}

describe("sending policy held after admission", () => {
  it("under restoration fails the row with the hold reason and hands its reservation back", async () => {
    const email = await seed(["one@example.invalid"]);
    await setAccepted(5);
    const d = deps(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("failed");
      expect(warn).toHaveBeenCalledWith(
        `email.send: sending policy held after admission, failed ${email.id}`,
      );
    } finally {
      warn.mockRestore();
    }
    expect(d.smtp).not.toHaveBeenCalled();
    expect(d.ses).not.toHaveBeenCalled();
    const { row, events } = await stored(email.id);
    // Before the fix: "queued", no event, reservation kept: stranded.
    expect(row).toEqual({ status: "failed", sentAt: null });
    expect(events).toEqual([
      {
        type: "failed",
        data: {
          source: "worker",
          reason: "sending_policy_held_after_admission",
          detail: "restoration_fenced",
        },
      },
    ]);
    expect(await accepted()).toBe(4);
    // Terminal: a replayed job is skipped and touches nothing.
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("skipped");
    expect(await accepted()).toBe(4);
    expect((await stored(email.id)).events).toHaveLength(1);
  });

  it("without restoration still parks the same content as queued_quota", async () => {
    // Off restoration the transactional lane is SES on a verified team domain.
    const [domain] = await fixture.db
      .insert(schema.domains)
      .values({
        teamId: team,
        name: "example.invalid",
        region: "us-east-1",
        status: "verified",
        verifiedAt: new Date(),
      })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain seed failed");
    const email = await seed(["two@example.invalid"], domain.id);
    const d = deps(false);
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
    expect(d.smtp).not.toHaveBeenCalled();
    expect(d.ses).not.toHaveBeenCalled();
    const { row, events } = await stored(email.id);
    expect(row).toEqual({ status: "queued_quota", sentAt: null });
    expect(events).toEqual([]);
  });
});
