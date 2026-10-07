import { recordProbes } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import {
  createMailboxProvisioningClient,
  mailboxReceivingCapacity,
  parseMailboxProvisioningConfiguration,
} from "@millionsend/ses";
import { mailOperator, type SystemMailer } from "../system-mail.js";

export interface MailboxCapacityDeps {
  /** MAILBOX_RECEIVING_PROVISIONING_CONFIG; unset means Correio receiving is not provisioned here. */
  configuration: string | undefined;
  credentials: { accessKeyId?: string; secretAccessKey?: string };
  mailer?: SystemMailer | undefined;
  appBaseUrl?: string | undefined;
  /** Kept by the caller across runs: the last notice's time and the share it reported. */
  state: { mailedAt: Date | null; mailedShare: number };
  now?: Date | undefined;
  /** Tests hand in the reading instead of an SES call. */
  read?: () => Promise<{ used: number; total: number; rules: number }>;
}

/** From this share of the receiving slots the operator hears about it. */
export const MAILBOX_CAPACITY_WARN = 0.8;
/** A second, louder line: a notice goes out on crossing it whatever the clock says. */
export const MAILBOX_CAPACITY_CRITICAL = 0.95;
export const MAILBOX_CAPACITY_MAIL_INTERVAL_MS = 24 * 3600_000;

/**
 * How full the Correio receiving rules are, as a console probe, and one
 * notice to the operator past 80% (again at 95%, then at most daily). The
 * clock lives in the worker's memory, so a restart may repeat it once early.
 */
export async function runMailboxCapacity(
  db: Db,
  deps: MailboxCapacityDeps,
): Promise<{ used: number; total: number; share: number } | null> {
  const config = parseMailboxProvisioningConfiguration(deps.configuration);
  if (!config) return null;
  const now = deps.now ?? new Date();
  const reading = await (deps.read
    ? deps.read()
    : mailboxReceivingCapacity(
        createMailboxProvisioningClient({ region: config.region, ...deps.credentials }),
        config,
      ));
  const share = reading.total > 0 ? reading.used / reading.total : 1;
  await recordProbes(
    db,
    [{ probe: "mailbox_receiving_used_rate", value: share, ok: share < MAILBOX_CAPACITY_WARN }],
    now,
  );
  const last = deps.state.mailedAt;
  const due =
    share >= MAILBOX_CAPACITY_WARN &&
    (last === null ||
      (share >= MAILBOX_CAPACITY_CRITICAL && deps.state.mailedShare < MAILBOX_CAPACITY_CRITICAL) ||
      now.getTime() - last.getTime() >= MAILBOX_CAPACITY_MAIL_INTERVAL_MS);
  if (due && deps.mailer) {
    deps.state.mailedAt = now;
    deps.state.mailedShare = share;
    try {
      await mailOperator(
        db,
        deps.mailer,
        "mailbox.capacity",
        "/console",
        {
          share: `${Math.round(share * 100)}%`,
          used: String(reading.used),
          total: String(reading.total),
          rules: String(reading.rules),
        },
        deps.appBaseUrl,
      );
    } catch (err) {
      console.error("mailbox.capacity: operator mail failed", err);
    }
  }
  return { used: reading.used, total: reading.total, share };
}
