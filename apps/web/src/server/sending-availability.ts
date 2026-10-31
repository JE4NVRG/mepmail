import { parseSendingProviderPolicy } from "@millionsend/core";
import { campaignSendWindowOpen } from "../../../../packages/core/src/campaign-send-window";

export type SendingAvailability = { state: "normal" | "limited" | "paused" };

/** Presentation only. This never admits a message or exposes operator policy/cohorts. */
export function sendingAvailability(input: {
  teamId: string;
  sesPaused: boolean;
  policyRaw: string | undefined;
  relayConfigured: boolean;
  now?: Date;
}): SendingAvailability {
  let policy: ReturnType<typeof parseSendingProviderPolicy>;
  try {
    policy = parseSendingProviderPolicy(input.policyRaw);
  } catch {
    return { state: "paused" };
  }
  if (policy?.paused || (policy?.allowedTeamIds && !policy.allowedTeamIds.includes(input.teamId))) {
    return { state: "paused" };
  }
  const transactional =
    policy?.teams?.[input.teamId]?.transactional ?? policy?.defaults?.transactional ?? "ses";
  const campaign = policy?.teams?.[input.teamId]?.campaign ?? policy?.defaults?.campaign ?? "ses";
  const now = input.now ?? new Date();
  let relayScope = true;
  if (policy?.restoration) {
    const own = policy.restoration.teams[input.teamId];
    const exactCampaign = policy.restoration.campaignCohort;
    relayScope = !!own && own.senders.length > 0 && now.getTime() >= Date.parse(own.notBefore);
    if (exactCampaign?.teamId === input.teamId) {
      relayScope =
        exactCampaign.messages.length > 0 && campaignSendWindowOpen(exactCampaign.sendWindow, now);
    }
    // A closed restoration cannot return to SES just because the platform probe recovers.
    if (!relayScope) return { state: "paused" };
  }
  if (
    input.relayConfigured &&
    relayScope &&
    [transactional, campaign].some((p) => p === "azure_smtp" || p === "customer_smtp")
  ) {
    return { state: "limited" };
  }
  if (!policy?.restoration && !input.sesPaused && [transactional, campaign].includes("ses")) {
    return { state: "normal" };
  }
  return { state: "paused" };
}
