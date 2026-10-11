import { getUntypedClient } from "@trpc/client";
import { useCallback } from "react";
import { useTRPCClient } from "@/lib/trpc";

/**
 * The onboarding steps the server counts, once per team each (onboarding.track),
 * so the funnel can be compared before and after the domain-first flow.
 */
export type OnboardingEvent =
  | "domain_viewed"
  | "domain_added"
  | "dns_provider"
  | "cloudflare_opened"
  | "cloudflare_configured"
  | "guide_opened"
  | "verify_clicked"
  | "domain_verified"
  | "mailbox_clicked"
  | "agent_clicked"
  | "api_opened"
  | "skip_domain"
  | "skip_dns"
  | "skip_mailbox";

/**
 * Records one onboarding step. Best-effort: a measurement never blocks the
 * person, so failures are dropped. The call goes by path through the untyped
 * client, so this compiles before the router has the procedure.
 */
export function useOnboardingTrack(): (event: OnboardingEvent, detail?: string) => void {
  const client = useTRPCClient();
  return useCallback(
    (event, detail) => {
      getUntypedClient(client)
        .mutation("onboarding.track", detail ? { step: event, detail } : { step: event })
        .catch(() => {});
    },
    [client],
  );
}
