import assert from "node:assert/strict";
import type { Db } from "@millionsend/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  alertRetainedMailboxSends,
  mailboxSendHoldAlertDecision as decide,
} from "./mailbox-send-hold-alerts.js";

const now = new Date("2026-11-12T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000);
const cases: string[] = [];
async function test(name: string, body: () => unknown) {
  await body();
  cases.push(name);
  console.log(`PASS ${name}`);
}
interface LedgerRow {
  target: string;
  action: string;
  createdAt: Date;
  data: { kind: string; text: string; [key: string]: unknown };
}
interface Group {
  code: string;
  count: string;
  oldest: string;
}
const dialect = new PgDialect();
const ledger: LedgerRow[] = [];
let groups: Group[] = [];
let locked = false;
let unresolved = false;
let failWrite = false;
let failRead = false;
let queryCount = 0;
const queries: string[] = [];
function adapter(): Db {
  return {
    async transaction(run: (tx: unknown) => Promise<unknown>) {
      let owns = false;
      const before = ledger.length;
      try {
        return await run({
          async execute(statement: SQL) {
            const { sql: query, params } = dialect.sqlToQuery(statement);
            queryCount++;
            queries.push(query);
            if (failRead) throw new Error("synthetic read failure");
            if (query.includes("set local")) return [];
            if (query.includes("pg_try_advisory_xact_lock")) {
              if (locked) return [{ acquired: false }];
              locked = true;
              owns = true;
              return [{ acquired: true }];
            }
            if (query.includes("select exists")) {
              assert.equal(params.length, 1);
              assert.equal(typeof params[0], "string");
              return [{ pending: unresolved }];
            }
            if (query.includes("group by error_code")) {
              assert.equal(params.length, 12);
              assert.ok(params.every((p) => String(p).startsWith("mailbox_deferred:")));
              assert.ok(!params.includes("mailbox_deferred:arbitrary-private-error"));
              return groups;
            }
            if (query.includes("from audit_log")) {
              assert.match(query, /limit 1/);
              const rows = ledger.filter((row) => row.target === params[1]);
              const last = rows.at(-1);
              return last ? [{ kind: last.data.kind, created: last.createdAt.toISOString() }] : [];
            }
            if (query.includes("select id from mailbox_outbox")) {
              assert.match(query, /limit 3/);
              return [{ id: "00000000-0000-4000-8000-000000000001" }];
            }
            throw new Error(`unexpected query: ${query}`);
          },
          insert() {
            return {
              async values(row: LedgerRow) {
                if (failWrite) throw new Error("synthetic insert failure");
                ledger.push(row);
              },
            };
          },
        });
      } catch (error) {
        if (owns) ledger.splice(before);
        throw error;
      } finally {
        if (owns) locked = false;
      }
    },
  } as unknown as Db;
}
async function main() {
  const old = { count: 2, oldestAt: ago(15) };
  const active = { kind: "mailbox.send_hold.retained" as const, createdAt: ago(1) };
  await test("empty does not alert", () => assert.equal(decide(null, null, now), null));
  await test("strict 15 minute threshold", () =>
    assert.equal(decide({ ...old, oldestAt: ago(14.999) }, null, now), null));
  await test("exactly 15 minutes alerts", () => assert.equal(decide(old, null, now), "retained"));
  await test("future timestamps do not alert", () =>
    assert.equal(decide({ ...old, oldestAt: ago(-1) }, null, now), null));
  await test("active cooldown suppresses", () => assert.equal(decide(old, active, now), null));
  await test("exactly 60 minute cooldown repeats", () =>
    assert.equal(decide(old, { ...active, createdAt: ago(60) }, now), "retained"));
  await test("recovery emitted once", () => assert.equal(decide(null, active, now), "recovered"));
  await test("recovered stays silent", () =>
    assert.equal(decide(null, { ...active, kind: "mailbox.send_hold.recovered" }, now), null));
  await test("new episode alerts after recovery", () =>
    assert.equal(decide(old, { ...active, kind: "mailbox.send_hold.recovered" }, now), "retained"));
  groups = [
    { code: "mailbox_deferred:provider_unavailable", count: "42", oldest: ago(20).toISOString() },
  ];
  await test("real module writes existing operator ledger", async () => {
    assert.equal((await alertRetainedMailboxSends(adapter(), now)).alerted, 1);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.action, "operator.alert");
    assert.equal(ledger[0]!.data.count, 42);
    assert.equal(ledger[0]!.data.oldestAgeMinutes, 20);
    assert.match(ledger[0]!.data.text, /reason=provider_unavailable/);
    assert.ok(!JSON.stringify(ledger).includes("recipient@"));
  });
  await test("fresh DB adapter simulates restart and deduplicates", async () => {
    assert.equal((await alertRetainedMailboxSends(adapter(), now)).alerted, 0);
    assert.equal(ledger.length, 1);
  });
  await test("concurrent cadence contenders do not duplicate", async () => {
    const results = await Promise.all([
      alertRetainedMailboxSends(adapter(), now),
      alertRetainedMailboxSends(adapter(), now),
    ]);
    assert.equal(results.filter((r) => r.skipped).length, 1);
    assert.equal(ledger.length, 1);
  });
  await test("cooldown durable reminder", async () => {
    assert.equal(
      (await alertRetainedMailboxSends(adapter(), new Date(now.getTime() + 3600000))).alerted,
      1,
    );
    assert.equal(ledger.length, 2);
  });
  groups = [];
  const later = new Date(now.getTime() + 3601000);
  await test("in-flight or ambiguous attempts cannot report recovery", async () => {
    unresolved = true;
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).recovered, 0);
    assert.equal(ledger.length, 2);
    unresolved = false;
  });
  await test("recovery ledger records once", async () => {
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).recovered, 1);
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).recovered, 0);
    assert.equal(ledger.length, 3);
  });
  groups = [
    { code: "mailbox_deferred:provider_unavailable", count: "1", oldest: ago(20).toISOString() },
  ];
  await test("new retained episode after recovery", async () => {
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).alerted, 1);
  });
  await test("busy lock skips all ledger/group reads", async () => {
    locked = true;
    const before = queryCount;
    assert.equal((await alertRetainedMailboxSends(adapter(), now)).skipped, true);
    assert.equal(queryCount - before, 3);
    locked = false;
  });
  groups.push({
    code: "mailbox_deferred:quota_exceeded",
    count: "4",
    oldest: ago(30).toISOString(),
  });
  await test("failed insert cannot stop reconcile and remains retryable", async () => {
    const before = ledger.length;
    failWrite = true;
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).failed, true);
    assert.equal(ledger.length, before);
    failWrite = false;
    assert.equal((await alertRetainedMailboxSends(adapter(), later)).alerted, 1);
  });
  await test("failed read never throws", async () => {
    failRead = true;
    assert.equal((await alertRetainedMailboxSends(adapter(), now)).failed, true);
    failRead = false;
  });
  await test("bounded reads select no raw MIME or recipient fields", () => {
    assert.ok(queries.some((q) => q.includes("group by error_code limit 12")));
    assert.ok(queries.every((q) => !/ciphertext|wrapped_dek|recipient_hashes|select \*/i.test(q)));
    assert.ok(queries.some((q) => q.includes("statement_timeout")));
    assert.ok(queries.some((q) => q.includes("lock_timeout")));
  });
  console.log(JSON.stringify({ success: true, count: cases.length, cases }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
