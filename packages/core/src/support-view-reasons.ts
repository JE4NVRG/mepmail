// Pure list, safe to import from client components (no db or node imports).
// Mirrors schema.supportViewReasonEnum; the db enum is the only other copy.
export const SUPPORT_VIEW_REASONS = ["support_ticket", "billing_dispute", "other"] as const;
export type SupportViewReason = (typeof SUPPORT_VIEW_REASONS)[number];

/**
 * Whether a reason must name the request it answers. Every reason here rests
 * on the customer having asked, so only "other" is free-form, and even that
 * one carries a reference when the operator has one. The dialog and the
 * procedure read this same rule.
 */
export function supportViewNeedsReference(reason: SupportViewReason): boolean {
  return reason === "support_ticket" || reason === "billing_dispute";
}
