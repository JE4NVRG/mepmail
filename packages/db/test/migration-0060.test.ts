import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { migrationsFolder } from "../src/migrate.js";

const tag = "0060_graduated_sending_capacity";
const migration = readMigrationFiles({ migrationsFolder }).find((entry) =>
  entry.sql.some((statement) => statement.includes("CREATE TABLE sending_judge_account_debt")),
);

it("exposes each top-level statement to Drizzle without splitting SQL bodies", () => {
  expect(migration).toBeDefined();
  expect(migration?.sql).toHaveLength(14);
  const source = readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8");
  expect(source.match(/--> statement-breakpoint/g)).toHaveLength(13);
  const guard = migration?.sql.find((statement) =>
    statement.includes("CREATE FUNCTION sending_judge_subject_guard()"),
  );
  expect(guard).toContain("RAISE EXCEPTION 'Judge subject identity is immutable'");
  expect(guard).toContain("RETURN NEW;\nEND $$;");
  expect(guard).not.toContain("CREATE TRIGGER");
});

it.each([false, true])(
  "executes the real Drizzle chunks and preserves source identity (native table=%s)",
  async (nativePresent) => {
    const client = new PGlite();
    const db = drizzle(client);
    try {
      // Minimal prior catalog, not a substitute migration or copied SQL body.
      await client.query("CREATE TABLE teams (id uuid PRIMARY KEY)");
      await client.query("CREATE TABLE emails (id uuid PRIMARY KEY)");
      await client.query("CREATE TABLE audit_log (team_id uuid, target text, action text)");
      if (nativePresent) await client.query("CREATE TABLE mailbox_outbox (id uuid PRIMARY KEY)");
      expect(migration).toBeDefined();
      if (!migration) throw new Error("migration 0060 is missing from the actual journal");
      // query-backed db.execute exercises the prepared-statement failure boundary;
      // client.exec would accept multiple statements and hide the original bug.
      for (const statement of migration.sql) await db.execute(sql.raw(statement));
      const team = "00000000-0000-4000-8000-000000000001";
      const message = "00000000-0000-4000-8000-000000000002";
      const attempt = "00000000-0000-4000-8000-000000000003";
      await client.query("INSERT INTO teams VALUES ($1)", [team]);
      await client.query("INSERT INTO emails VALUES ($1)", [message]);
      const insert = `INSERT INTO sending_judge_attempts
        (account_key, attempt_id, team_id, message_kind, message_id, email_id,
         fingerprint, reserved_tokens, reserved_units)
        VALUES ('fixture', $1, $2, 'email', $3, $4, $5, 1, 1)`;
      await expect(
        client.query(insert, [attempt, team, message, null, "a".repeat(64)]),
      ).rejects.toThrow("Judge attempt requires a concrete source witness");
      await client.query(insert, [attempt, team, message, message, "a".repeat(64)]);
      await expect(
        client.query("UPDATE sending_judge_attempts SET fingerprint = $1", ["b".repeat(64)]),
      ).rejects.toThrow("Judge subject identity is immutable");
      await expect(
        client.query("UPDATE sending_judge_attempts SET team_id = $1", [message]),
      ).rejects.toThrow("Judge subject identity is immutable");
      await expect(
        client.query("UPDATE sending_judge_attempts SET state = 'settled'"),
      ).rejects.toThrow();
      await client.query("DELETE FROM emails WHERE id = $1", [message]);
      const retained = await client.query<{ message_id: string; email_id: string | null }>(
        "SELECT message_id, email_id FROM sending_judge_attempts",
      );
      expect(retained.rows).toEqual([{ message_id: message, email_id: null }]);
      const nativeFk = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'sending_judge_native_source_fk'",
      );
      expect(nativeFk.rows[0]?.n).toBe(nativePresent ? 1 : 0);
      if (nativePresent) {
        await client.query("INSERT INTO mailbox_outbox VALUES ($1)", [message]);
        await client.query(
          `INSERT INTO sending_judge_attempts
            (account_key, attempt_id, team_id, message_kind, message_id, mailbox_outbox_id,
             fingerprint, reserved_tokens, reserved_units)
           VALUES ('native-fixture', $1, $2, 'mailbox', $3, $3, $4, 1, 1)`,
          [attempt, team, message, "a".repeat(64)],
        );
        await client.query("DELETE FROM mailbox_outbox WHERE id = $1", [message]);
        const nativeRetained = await client.query<{
          message_id: string;
          mailbox_outbox_id: string | null;
        }>(
          "SELECT message_id, mailbox_outbox_id FROM sending_judge_attempts WHERE account_key = 'native-fixture'",
        );
        expect(nativeRetained.rows).toEqual([{ message_id: message, mailbox_outbox_id: null }]);
      }
    } finally {
      await client.close();
    }
  },
);
