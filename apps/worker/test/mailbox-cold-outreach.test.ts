import { randomUUID } from "node:crypto";
import type { MailboxOutboxSender } from "@millionsend/core";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { JudgeVerdict } from "../../../packages/core/src/abuse-judge/types.js";
import { withMailboxDispatchContent } from "../src/mailbox-dispatch-content.js";
import { authorizeWorkerDispatch, installWorkerMailboxSchema } from "./worker-dispatch-fixture.js";

const clean: JudgeVerdict = {
  score: 0,
  verdict: "clean",
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};

let database: Awaited<ReturnType<typeof createTestDb>>;
let teamId: string;

beforeAll(async () => {
  database = await createTestDb();
  await installWorkerMailboxSchema(database.db);
  teamId = await createTeam(database.db, randomUUID());
});

afterAll(async () => {
  await database?.close();
});

function message(from: string, subject: string) {
  return Buffer.from(
    `From: ${from}\r\nTo: one@example.invalid\r\nSubject: ${subject}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n",
  );
}

async function fixture(from: string, subject: string) {
  const input: Parameters<MailboxOutboxSender["send"]>[0] = {
    idempotencyKey: randomUUID(),
    outboxId: randomUUID(),
    attemptId: randomUUID(),
    teamId,
    mailboxId: randomUUID(),
    from,
    to: ["one@example.invalid"],
    cc: [],
    bcc: [],
    raw: message(from, subject),
  };
  const db = database.db;
  await authorizeWorkerDispatch(db, input);
  const judge = {
    provider: "openai" as const,
    model: "synthetic",
    judge: vi.fn(async (_block: string, _opts: { signal: AbortSignal }) => clean),
  };
  return { input, db, judge };
}

// The exact sender and shape that paused the account: a clean copy is not a defence,
// because the harm was sending at all. The hold carries its own reason so an operator
// cannot release it by approving the content review.
it("holds prospecting sent from the address that paused the account", async () => {
  const { input, db, judge } = await fixture("parcerias@urlpivot.app", "Sponsorship opportunities");
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "cold_outreach" });
  expect(send).not.toHaveBeenCalled();
});

it("holds a cold-outreach subject even when the sender is ordinary", async () => {
  const { input, db, judge } = await fixture("sender@example.invalid", "Guest post proposal");
  const send = vi.fn();
  await expect(
    withMailboxDispatchContent(db, input, judge, true, async () => send()),
  ).rejects.toMatchObject({ reason: "cold_outreach" });
  expect(send).not.toHaveBeenCalled();
});

it("still sends a transactional message from an ordinary sender", async () => {
  const { input, db, judge } = await fixture("sender@example.invalid", "Your November invoice");
  const send = vi.fn(async () => "ok");
  await expect(withMailboxDispatchContent(db, input, judge, true, send)).resolves.toBe("ok");
  expect(send).toHaveBeenCalledTimes(1);
});
