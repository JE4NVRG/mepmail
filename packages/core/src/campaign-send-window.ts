import { z } from "zod";

// Explicit UTC, millisecond-or-coarser precision: no offset/rounding ambiguity.
const utcInstant = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
export const campaignSendWindowSchema = z
  .object({ startsAt: utcInstant, endsAt: utcInstant })
  .strict()
  .refine((window) => Date.parse(window.startsAt) < Date.parse(window.endsAt), {
    message: "campaign_send_window_must_increase",
  });
export type CampaignSendWindow = z.infer<typeof campaignSendWindowSchema>;

/** Start inclusive, end exclusive. Missing/invalid windows and clocks fail closed. */
export function campaignSendWindowOpen(window: unknown, now: Date = new Date()): boolean {
  const parsed = campaignSendWindowSchema.safeParse(window);
  const at = now.getTime();
  return (
    parsed.success &&
    Number.isFinite(at) &&
    at >= Date.parse(parsed.data.startsAt) &&
    at < Date.parse(parsed.data.endsAt)
  );
}
