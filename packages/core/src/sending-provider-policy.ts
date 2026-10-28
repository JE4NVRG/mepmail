import { z } from "zod";

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
      reason: "operator_paused" | "team_not_allowed" | "provider_unavailable" | "provider_paused";
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
    teamId: string;
    messageClass: SendingMessageClass;
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
  const team = policy?.teams?.[input.teamId]?.[input.messageClass];
  const fallback = policy?.defaults?.[input.messageClass];
  const provider = team ?? fallback ?? input.legacyProvider;
  if (!input.availableProviders.has(provider))
    return { kind: "held", reason: "provider_unavailable" };
  if (input.blockedProviders?.has(provider)) return { kind: "held", reason: "provider_paused" };
  return { kind: "selected", provider, source: team ? "team" : fallback ? "default" : "legacy" };
}
