// Pure list, safe to import from client components (no db or node imports).
// Mirrors schema.supportViewReasonEnum; the db enum is the only other copy.
export const SUPPORT_VIEW_REASONS = [
  "support_ticket",
  "abuse_report_check",
  "billing_dispute",
  "other",
] as const;
export type SupportViewReason = (typeof SUPPORT_VIEW_REASONS)[number];

/**
 * Whether a reason must name the request it answers. The two that rest on
 * the customer's own instruction do; the security one and "other" do not.
 * The dialog and the procedure read this same rule.
 */
export function supportViewNeedsReference(reason: SupportViewReason): boolean {
  return reason === "support_ticket" || reason === "billing_dispute";
}
