import type {
  MailboxInboundAssessment,
  MailboxSafetyReason,
  MailboxVerdict,
} from "../../db/src/schema/mailbox-items.js";

export type {
  MailboxInboundAssessment,
  MailboxSafetyReason,
  MailboxVerdict,
} from "../../db/src/schema/mailbox-items.js";

const VERDICTS: readonly MailboxVerdict[] = [
  "PASS",
  "FAIL",
  "GRAY",
  "PROCESSING_FAILED",
  "UNKNOWN",
];
const POLICIES = ["none", "quarantine", "reject"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function field(value: Record<string, unknown> | null, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}
function isVerdict(value: unknown): value is MailboxVerdict {
  return typeof value === "string" && VERDICTS.includes(value as MailboxVerdict);
}
function policy(value: unknown): MailboxInboundAssessment["dmarcPolicy"] {
  return typeof value === "string" && POLICIES.includes(value as (typeof POLICIES)[number])
    ? (value as (typeof POLICIES)[number])
    : null;
}
function receiptVerdict(value: unknown): MailboxVerdict {
  const status = field(record(value), "status");
  return isVerdict(status) ? status : "UNKNOWN";
}

function derive(
  verdicts: MailboxInboundAssessment["verdicts"],
  dmarcPolicy: MailboxInboundAssessment["dmarcPolicy"],
): MailboxInboundAssessment {
  const reasons: MailboxSafetyReason[] = [];
  if (verdicts.virus !== "PASS")
    reasons.push(verdicts.virus === "FAIL" ? "virus" : "virus_unchecked");
  if (verdicts.spam === "FAIL") reasons.push("spam");
  else if (verdicts.spam === "GRAY") reasons.push("spam_uncertain");
  else if (verdicts.spam !== "PASS") reasons.push("spam_unchecked");
  if (verdicts.dmarc === "FAIL" && (dmarcPolicy === "quarantine" || dmarcPolicy === "reject"))
    reasons.push("sender_policy");
  if (verdicts.spf === "FAIL" && verdicts.dkim === "FAIL") reasons.push("sender_authentication");
  return {
    version: 1,
    decision: verdicts.virus !== "PASS" ? "quarantine" : reasons.length ? "spam" : "inbox",
    verdicts: { ...verdicts },
    dmarcPolicy,
    reasons,
  };
}

/** Only a receipt from the authenticated transport is authoritative. MIME headers
 * and sender-provided verdicts must never be passed as a receipt by the adapter.
 */
export function assessMailboxReceipt(receipt: unknown): MailboxInboundAssessment {
  const captured = record(receipt);
  return derive(
    {
      virus: receiptVerdict(field(captured, "virusVerdict")),
      spam: receiptVerdict(field(captured, "spamVerdict")),
      spf: receiptVerdict(field(captured, "spfVerdict")),
      dkim: receiptVerdict(field(captured, "dkimVerdict")),
      dmarc: receiptVerdict(field(captured, "dmarcVerdict")),
    },
    policy(field(captured, "dmarcPolicy")),
  );
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function invalid(): never {
  throw new Error("Invalid mailbox inbound assessment");
}
function checkedVerdict(value: unknown): MailboxVerdict {
  return isVerdict(value) ? value : invalid();
}

/** Capture an untrusted/serialized assessment, then independently rederive its
 * decision and ordered reasons. A caller cannot downgrade quarantine to Inbox.
 */
export function validateMailboxInboundAssessment(value: unknown): MailboxInboundAssessment {
  const captured = record(value);
  if (
    !captured ||
    !exactKeys(captured, ["version", "decision", "verdicts", "dmarcPolicy", "reasons"])
  )
    invalid();
  const suppliedVerdicts = record(captured.verdicts);
  if (!suppliedVerdicts || !exactKeys(suppliedVerdicts, ["virus", "spam", "spf", "dkim", "dmarc"]))
    invalid();
  const suppliedPolicy = captured.dmarcPolicy;
  if (suppliedPolicy !== null && policy(suppliedPolicy) !== suppliedPolicy) invalid();
  const expected = derive(
    {
      virus: checkedVerdict(suppliedVerdicts.virus),
      spam: checkedVerdict(suppliedVerdicts.spam),
      spf: checkedVerdict(suppliedVerdicts.spf),
      dkim: checkedVerdict(suppliedVerdicts.dkim),
      dmarc: checkedVerdict(suppliedVerdicts.dmarc),
    },
    suppliedPolicy as MailboxInboundAssessment["dmarcPolicy"],
  );
  const suppliedReasons = captured.reasons;
  if (
    captured.version !== 1 ||
    captured.decision !== expected.decision ||
    !Array.isArray(suppliedReasons) ||
    suppliedReasons.length !== expected.reasons.length ||
    expected.reasons.some((reason, index) => suppliedReasons[index] !== reason)
  )
    invalid();
  return expected;
}
