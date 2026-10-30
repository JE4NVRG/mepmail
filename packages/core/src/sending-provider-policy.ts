import { createHash } from "node:crypto";
import { z } from "zod";
import { campaignSendWindowOpen, campaignSendWindowSchema } from "./campaign-send-window.js";

/** Routing is operator-owned configuration, never a client-supplied send option. */
const providerId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const routes = z
  .object({ transactional: providerId.optional(), campaign: providerId.optional() })
  .strict();
const policySchema = z
  .object({
    version: z.literal(1),
    paused: z.boolean().optional(),
    /** Present-but-empty deliberately admits no team. */
    allowedTeamIds: z.array(z.uuid()).max(10_000).optional(),
    restoration: z
      .object({
        campaignCohort: z
          .object({
            teamId: z.uuid(),
            sendWindow: campaignSendWindowSchema,
            from: z.email(),
            messages: z
              .array(
                z
                  .object({
                    emailId: z.uuid(),
                    createdAt: z.iso.datetime({ offset: true }),
                    recipientHash: z.string().regex(/^[a-f0-9]{64}$/),
                  })
                  .strict(),
              )
              .min(1)
              .max(5),
          })
          .strict()
          .optional(),
        teams: z.record(
          z.uuid(),
          z
            .object({
              notBefore: z.iso.datetime({ offset: true }),
              senders: z.array(z.email()).min(1).max(100),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    defaults: routes.optional(),
    teams: z.record(z.uuid(), routes).optional(),
  })
  .strict();

export type SendingProviderPolicy = z.infer<typeof policySchema>;
export type SendingMessageClass = "transactional" | "campaign";
export type SendingProviderDecision =
  | { kind: "selected"; provider: string; source: "legacy" | "default" | "team" }
  | {
      kind: "held";
      reason:
        | "operator_paused"
        | "team_not_allowed"
        | "provider_unavailable"
        | "provider_paused"
        | "restoration_fenced";
    };

/** Malformed configuration throws: it must never silently become legacy routing. */
export function parseSendingProviderPolicy(raw: string | undefined): SendingProviderPolicy | null {
  if (raw === undefined || raw.trim() === "") return null;
  const policy = policySchema.parse(JSON.parse(raw) as unknown);
  if (
    policy.allowedTeamIds &&
    new Set(policy.allowedTeamIds).size !== policy.allowedTeamIds.length
  ) {
    throw new Error("sending_provider_policy_duplicate_team");
  }
  if (
    policy.restoration &&
    (!policy.allowedTeamIds ||
      policy.defaults?.campaign !== "disabled" ||
      policy.defaults?.transactional !== "disabled" ||
      Object.entries(policy.restoration.teams).some(
        ([id, cohort]) =>
          !policy.allowedTeamIds?.includes(id) ||
          policy.teams?.[id]?.transactional !== "azure_smtp" ||
          policy.teams?.[id]?.campaign !== "disabled" ||
          cohort.senders.some((sender) => sender !== sender.toLowerCase()),
      ))
  ) {
    throw new Error("sending_provider_restoration_must_be_closed");
  }
  const campaign = policy.restoration?.campaignCohort;
  if (
    campaign &&
    (policy.restoration?.teams[campaign.teamId] !== undefined ||
      !policy.allowedTeamIds?.includes(campaign.teamId) ||
      policy.teams?.[campaign.teamId]?.transactional !== "disabled" ||
      policy.teams?.[campaign.teamId]?.campaign !== "azure_smtp" ||
      campaign.from !== campaign.from.toLowerCase() ||
      new Set(campaign.messages.map((m) => m.emailId)).size !== campaign.messages.length ||
      campaign.messages.some((m) => !/^[a-f0-9]{64}$/.test(m.recipientHash)))
  )
    throw new Error("sending_provider_campaign_must_be_closed");
  return policy;
}

/**
 * Select exactly one configured transport AFTER the shared tenant/content/consent
 * guards. Selecting a provider never authorizes a send or relaxes those guards.
 * There is no retry/fallback output: a paused/refused/ambiguous transport must not
 * cause a second provider to be selected for the same accepted message.
 */
export function resolveSendingProvider(
  policy: SendingProviderPolicy | null,
  input: {
    /** Fresh clock sample; never the email creation/scheduling timestamp. */
    now?: Date | undefined;
    teamId: string;
    messageClass: SendingMessageClass;
    emailId?: string;
    to?: readonly string[];
    cc?: readonly string[] | null;
    bcc?: readonly string[] | null;
    sentAt?: Date | null;
    sesMessageId?: string | null;
    latestStatus?: string;
    createdAt?: Date;
    fromAddress?: string;
    legacyProvider: "ses" | "customer_smtp";
    /** Only adapters that are configured AND authorized for this sender/domain. */
    availableProviders: ReadonlySet<string>;
    blockedProviders?: ReadonlySet<string>;
  },
): SendingProviderDecision {
  if (policy?.paused) return { kind: "held", reason: "operator_paused" };
  if (policy?.allowedTeamIds && !policy.allowedTeamIds.includes(input.teamId)) {
    return { kind: "held", reason: "team_not_allowed" };
  }
  if (policy?.restoration) {
    const campaign = policy.restoration.campaignCohort;
    if (campaign?.teamId === input.teamId) {
      const message = campaign.messages.find((m) => m.emailId === input.emailId);
      const recipient = input.to?.[0];
      if (
        !campaignSendWindowOpen(campaign.sendWindow, input.now) ||
        !message ||
        input.messageClass !== "campaign" ||
        input.createdAt?.getTime() !== Date.parse(message.createdAt) ||
        input.fromAddress?.toLowerCase() !== campaign.from ||
        input.to?.length !== 1 ||
        typeof recipient !== "string" ||
        recipient.trim().length === 0 ||
        createHash("sha256").update(recipient.trim().toLowerCase()).digest("hex") !==
          message.recipientHash ||
        (input.cc?.length ?? 0) !== 0 ||
        (input.bcc?.length ?? 0) !== 0 ||
        input.sentAt !== null ||
        input.sesMessageId !== null ||
        input.latestStatus !== "queued"
      )
        return { kind: "held", reason: "restoration_fenced" };
    } else {
      const cohort = policy.restoration.teams[input.teamId];
      if (
        !cohort ||
        input.messageClass !== "transactional" ||
        !input.createdAt ||
        !Number.isFinite(input.createdAt.getTime()) ||
        input.createdAt.getTime() < Date.parse(cohort.notBefore) ||
        !input.fromAddress ||
        !cohort.senders.includes(input.fromAddress.toLowerCase())
      ) {
        return { kind: "held", reason: "restoration_fenced" };
      }
    }
  }
  const team = policy?.teams?.[input.teamId]?.[input.messageClass];
  const fallback = policy?.defaults?.[input.messageClass];
  const provider = team ?? fallback ?? input.legacyProvider;
  if (policy?.restoration && provider !== "azure_smtp")
    return { kind: "held", reason: "restoration_fenced" };
  if (!input.availableProviders.has(provider))
    return { kind: "held", reason: "provider_unavailable" };
  if (input.blockedProviders?.has(provider)) return { kind: "held", reason: "provider_paused" };
  return { kind: "selected", provider, source: team ? "team" : fallback ? "default" : "legacy" };
}
