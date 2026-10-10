import {
  mailboxAliasAddresses,
  mailboxHoldReason,
  mailboxPlanUsage,
  mailboxSubscriptionUsagePeriod,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import {
  appendMailboxReceivingRecipients,
  createMailboxProvisioningClient,
  type MailboxProvisioningClient,
  mailboxRoutedRecipients,
  parseMailboxProvisioningConfiguration,
  removeMailboxReceivingRecipients,
} from "../../../../packages/ses/src/mailbox-provisioning.js";

export interface MailboxReceivingHoldDeps {
  /** MAILBOX_RECEIVING_PROVISIONING_CONFIG; absent leaves holds wanted but unapplied. */
  configuration?: string | undefined;
  credentials?: { accessKeyId?: string; secretAccessKey?: string };
  client?: () => MailboxProvisioningClient;
  now?: Date;
}

export interface MailboxReceivingHoldResult {
  paused: number;
  resumed: number;
  failed: number;
}

/** Every address SES routes for the team: its mailboxes and their aliases. */
async function teamAddresses(db: Db, teamId: string): Promise<string[]> {
  const boxes = await db
    .select({ id: schema.mailboxes.id, address: schema.mailboxes.address })
    .from(schema.mailboxes)
    .where(and(eq(schema.mailboxes.teamId, teamId), eq(schema.mailboxes.status, "planned")));
  const aliases = boxes.length
    ? await mailboxAliasAddresses(
        db,
        teamId,
        boxes.map((box) => box.id),
      )
    : [];
  return [...new Set([...boxes.map((b) => b.address), ...aliases.map((a) => a.address)])].sort();
}

/** Still wanted: the plan is a Correio plan and its usage or storage keeps the reason. */
async function stillHeld(db: Db, teamId: string, now: Date): Promise<boolean> {
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  if (!plan?.planCode) return false;
  const period = mailboxSubscriptionUsagePeriod(plan, now) ?? {
    start: plan.periodStart,
    end: plan.periodEnd,
  };
  return mailboxHoldReason(plan, await mailboxPlanUsage(db, teamId, period.start)) !== null;
}

/**
 * Applies receiving holds in SES and lifts them, one hold at a time under the shared
 * provisioning lock (the same one activation takes), from the per-minute schedule.
 *
 * A wanted hold takes the team's addresses out of the receipt rules: SES then refuses
 * their mail before accepting it, so nothing more is billed or stored. A hold whose
 * reason cleared (a new billing period, an upgrade, freed storage) puts back exactly
 * the addresses it took out. An SES failure keeps the row for the next run.
 */
export async function reconcileMailboxReceivingHolds(
  db: Db,
  deps: MailboxReceivingHoldDeps = {},
): Promise<MailboxReceivingHoldResult> {
  const result: MailboxReceivingHoldResult = { paused: 0, resumed: 0, failed: 0 };
  const config = parseMailboxProvisioningConfiguration(deps.configuration);
  const now = deps.now ?? new Date();
  const holds = await db
    .select({ teamId: schema.mailboxReceivingHolds.teamId })
    .from(schema.mailboxReceivingHolds);
  if (!config || !holds.length) return result;
  const client = () =>
    deps.client
      ? deps.client()
      : createMailboxProvisioningClient({ region: config.region, ...(deps.credentials ?? {}) });
  for (const { teamId } of holds) {
    try {
      const outcome = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('mailbox-receiving-provisioning'))`,
        );
        const [hold] = await tx
          .select()
          .from(schema.mailboxReceivingHolds)
          .where(eq(schema.mailboxReceivingHolds.teamId, teamId))
          .for("update");
        if (!hold) return null;
        const addresses = await teamAddresses(tx, teamId);
        if (await stillHeld(tx, teamId, now)) {
          if (hold.state === "paused") return null;
          const out = await removeAddresses(client, config, addresses);
          await tx
            .update(schema.mailboxReceivingHolds)
            .set({
              state: "paused",
              recipients: [...new Set([...hold.recipients, ...out])].sort(),
              updatedAt: new Date(),
            })
            .where(eq(schema.mailboxReceivingHolds.teamId, teamId));
          return "paused" as const;
        }
        // Only the team's current addresses go back; a deleted mailbox stays out.
        const back = hold.recipients.filter((x) => addresses.includes(x));
        if (back.length) await appendMailboxReceivingRecipients(client(), config, back);
        await tx
          .delete(schema.mailboxReceivingHolds)
          .where(eq(schema.mailboxReceivingHolds.teamId, teamId));
        return "resumed" as const;
      });
      if (outcome) result[outcome] += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(
        `mailbox.receiving: hold for ${teamId.slice(0, 8)} not applied`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

/** Takes the team's routed addresses out of SES; returns the ones it took out. */
async function removeAddresses(
  client: () => MailboxProvisioningClient,
  config: NonNullable<ReturnType<typeof parseMailboxProvisioningConfiguration>>,
  addresses: string[],
): Promise<string[]> {
  if (!addresses.length) return [];
  // Read first: only addresses SES routes now are taken out (and later put back).
  const routed = await mailboxRoutedRecipients(client(), config);
  const present = addresses.filter((x) => routed.has(x));
  if (!present.length) return [];
  await removeMailboxReceivingRecipients(client(), config, present);
  return present;
}
