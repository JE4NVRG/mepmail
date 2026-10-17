import { type Db, schema } from "@millionsend/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { generateApiKey, MAX_ACTIVE_API_KEYS } from "./api-keys.js";
import { prepareSignupRiskForApiKey } from "./signup-risk.js";
import { getSignupSendingRestriction } from "./signup-risk-enforcement.js";

export const MAX_SANDBOX_API_KEYS = 1;

export type ApiKeyIssuanceRefusal =
  | "team_missing"
  | "team_review_required"
  | "signup_api_key_restricted"
  | "signup_sandbox_key_limit"
  | "active_key_limit"
  | "invalid_domain";

export type ApiKeyIssuanceResult =
  | { allowed: true; id: string; token: string }
  | { allowed: false; reason: ApiKeyIssuanceRefusal };

/** One issuance path for dashboard, onboarding, REST and OAuth/MCP. Never
 * throws an authorization refusal inside the transaction: prospective risk
 * escalation and its audit must survive a refused key request. */
export async function issueApiKey(
  db: Db,
  input: {
    teamId: string;
    name: string;
    permission: "full_access" | "sending_access";
    domainId?: string | null;
    createdByApiKeyId?: string | null;
    isCloud: boolean;
    now?: Date;
  },
): Promise<ApiKeyIssuanceResult> {
  return db.transaction(async (transaction): Promise<ApiKeyIssuanceResult> => {
    const tx = transaction as unknown as Db;
    // Signup capture/verification acquire the same principal advisory locks
    // before their risk/team rows. Keep that order to avoid inverted waits.
    if (input.isCloud) await prepareSignupRiskForApiKey(tx, input);
    const [team] = await tx
      .select({
        id: schema.teams.id,
        held: schema.teams.sendReviewAt,
        suspended: schema.teams.suspendedAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    if (!team) return { allowed: false, reason: "team_missing" };
    if (input.isCloud && (team.held || team.suspended))
      return { allowed: false, reason: "team_review_required" };
    const restriction = await getSignupSendingRestriction(tx, input.teamId, input.isCloud);
    if (restriction.kind === "review") return { allowed: false, reason: "team_review_required" };
    if (restriction.kind === "sandbox") {
      if (!restriction.principalEmail || !restriction.principalVerified)
        return { allowed: false, reason: "team_review_required" };
      if (input.permission !== "sending_access")
        return { allowed: false, reason: "signup_api_key_restricted" };
    }
    // Every minter holds the team row until insert/commit, so concurrent
    // requests cannot exceed either the normal cap or the sandbox test cap.
    const [active] = await tx
      .select({ n: count() })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.teamId, input.teamId), isNull(schema.apiKeys.revokedAt)));
    const activeKeys = Number(active?.n ?? 0);
    if (restriction.kind === "sandbox" && activeKeys >= MAX_SANDBOX_API_KEYS)
      return { allowed: false, reason: "signup_sandbox_key_limit" };
    if (activeKeys >= MAX_ACTIVE_API_KEYS) return { allowed: false, reason: "active_key_limit" };
    if (input.domainId) {
      const [domain] = await tx
        .select({ id: schema.domains.id })
        .from(schema.domains)
        .where(
          and(
            eq(schema.domains.id, input.domainId),
            eq(schema.domains.teamId, input.teamId),
            eq(schema.domains.status, "verified"),
          ),
        )
        .for("share");
      if (!domain) return { allowed: false, reason: "invalid_domain" };
    }
    const generated = generateApiKey();
    const [row] = await tx
      .insert(schema.apiKeys)
      .values({
        teamId: input.teamId,
        name: input.name.trim(),
        tokenPrefix: generated.tokenPrefix,
        keyHash: generated.keyHash,
        last4: generated.last4,
        permission: input.permission,
        domainId: input.domainId ?? null,
        createdByApiKeyId: input.createdByApiKeyId ?? null,
        ...(input.now ? { createdAt: input.now } : {}),
      })
      .returning({ id: schema.apiKeys.id });
    if (!row) throw new Error("api_key_issuance_failed");
    return { allowed: true, id: row.id, token: generated.token };
  });
}

export function apiKeyIssuanceMessage(reason: ApiKeyIssuanceRefusal): string {
  switch (reason) {
    case "team_review_required":
      return "API key creation is awaiting account review. Your data and existing keys are preserved. Request a review in the dashboard.";
    case "signup_api_key_restricted":
      return "Full-access keys are awaiting account review. Create one sending-only test key to send only to your verified signup address, or request a review in the dashboard.";
    case "signup_sandbox_key_limit":
      return "The sandbox allows one active sending-only test key. Revoke the existing key before creating another, or request a review in the dashboard.";
    case "active_key_limit":
      return `A team can have at most ${MAX_ACTIVE_API_KEYS} active API keys; revoke one first.`;
    case "invalid_domain":
      return "domain_id must be a verified domain of this team";
    case "team_missing":
      return "Team not found";
  }
}
