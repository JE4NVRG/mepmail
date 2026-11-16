import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { sql } from "drizzle-orm";
import type { SendSaleCapacitySource } from "../src/send-sale-capacity.js";

/** Synthetic server-owned feed, injected per caller. Never replaces provider GETs globally.
 * This admits at most 4320 nominal messages/day; larger contracts still fail closed. */
export const fundedSaleCapacity: SendSaleCapacitySource = async () => {
  const at = Date.now();
  const units = 100_000_000_000_000;
  const receipt = {
    version: 1 as const,
    issuedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 5000).toISOString(),
    region: "us-east-1" as const,
    globalDaily: 4320,
    globalPerMinute: 3,
    tenantPerMinute: 3,
    judgePerMinute: 3,
    dailySemantics: "nominal-flow-ceiling-not-resource-guarantee" as const,
    commercial: {
      judgeTokensPerMinute: 3006144,
      nominalJudgeDailyTokens: 3006144 * 1440,
      worstCaseTokensPerAdmission: 1002048,
      worstCaseCostUsd: 0.3024576,
    },
    observations: {
      sesMax24HourSend: 1000000,
      sesSentLast24Hours: 0,
      sesUsefulNominalDaily: 980000,
      sesMaxSendRate: 14,
      modelBudgetScope: "original-primary-shared-not-exclusive" as const,
    },
    buffers: {
      sesRemaining24Hours: 980000,
      modelCreditUnitsAfterSafetyFloor: units,
      modelFramesBeforeLocalCommitments: Math.floor(units / 302457600),
      localCommitments: "parent-ledger-required" as const,
    },
  };
  return {
    judgeEnvelope: {
      accountKey: "commandcode-primary",
      meterId: randomUUID(),
      meterAt: receipt.issuedAt,
      meterExpiresAt: receipt.expiresAt,
      rpm: 3,
      tenantRpm: 3,
      tpm: 3006144,
      concurrency: 1,
      maxInputTokens: 1000000,
      maxOutputTokens: 2048,
      reservedCreditUnits: 302457600,
      remainingCreditUnits: units,
    },
    capacityReceipt: receipt,
    regionalCapacity: { "us-east-1": receipt, "eu-west-1": null },
  };
};

/** Query-shaped private projection tables, scoped to the disposable billing DB.
 * Install a complete Native source instead of falsely claiming no historical Native
 * installation while MAIN already contains mailbox_* relations. Existing full tables
 * are retained; no production migration or fixture-wide source mock is involved. */
export async function installBillingControls(db: Db): Promise<void> {
  for (const statement of [
    "create table if not exists sending_judge_attempts (account_key text, attempt_id uuid, team_id uuid, message_kind text, state text, reserved_units bigint)",
    "create table if not exists sending_judge_account_debt (account_key text primary key, debt_units bigint not null default 0, last_meter_id text, last_meter_at timestamptz, last_remaining_units bigint)",
    "create table if not exists mailbox_outbox (id uuid primary key, team_id uuid, mailbox_id uuid, accepted_at timestamptz, attempt_id uuid, provider_message_id text, status text, created_at timestamptz, recipient_hashes text[])",
    "create table if not exists mailbox_outbound_events (id text primary key, outbox_id uuid, attempt_id uuid, provider_message_id text, outcome text, occurred_at timestamptz, received_at timestamptz)",
    "create table if not exists mailbox_outbound_outcomes (event_id text, recipient_hash text)",
    "create table if not exists mailboxes (id uuid primary key, team_id uuid, domain_id uuid, origin text default 'domain')",
    "alter table mailboxes add column if not exists origin text default 'domain'",
  ])
    await db.execute(sql.raw(statement));
}
