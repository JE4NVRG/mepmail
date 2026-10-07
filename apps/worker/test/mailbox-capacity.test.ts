import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMailboxCapacity } from "../src/handlers/mailbox-capacity.js";
import type { SystemMailer } from "../src/system-mail.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const CONFIG = JSON.stringify({
  version: 2,
  region: "us-east-1",
  ruleSetName: "mepmail-mailboxes",
  rules: [{ ruleName: "piloto-exato", protectedRuleSha256: "a".repeat(64) }],
});

const mailer = { send: async () => {} } as unknown as SystemMailer;

it("does nothing where Correio receiving is not provisioned", async () => {
  const state = { mailedAt: null, mailedShare: 0 };
  expect(
    await runMailboxCapacity(db, { configuration: undefined, credentials: {}, state }),
  ).toBeNull();
});

it("records the share as a probe and notices past 80%, again on crossing 95%, then daily", async () => {
  const state = { mailedAt: null as Date | null, mailedShare: 0 };
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 4, minutes));
  const run = (used: number, now: Date) =>
    runMailboxCapacity(db, {
      configuration: CONFIG,
      credentials: {},
      mailer,
      state,
      now,
      read: async () => ({ used, total: 1000, rules: 10 }),
    });

  expect(await run(110, at(0))).toEqual({ used: 110, total: 1000, share: 0.11 });
  expect(state.mailedAt).toBeNull();
  const probes = await db
    .select()
    .from(schema.instanceProbes)
    .where(eq(schema.instanceProbes.probe, "mailbox_receiving_used_rate"));
  expect(probes).toMatchObject([{ value: 0.11, ok: true }]);

  await run(810, at(15));
  expect(state.mailedAt).toEqual(at(15));
  await run(850, at(30));
  expect(state.mailedAt).toEqual(at(15));
  await run(960, at(45));
  expect(state.mailedAt).toEqual(at(45));
});
