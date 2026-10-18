"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { DeliverabilityBanner } from "./deliverability-banner";
import { EventsHealthBanner } from "./events-health-banner";
import { RegionBreakerBanner } from "./region-breaker-banner";
import { TeamStandingBanner } from "./team-standing-banner";

/** Avoid mounting private team probes until the live current-team policy is known. */
export function TeamHealthBanners({ standingOnly = false }: { standingOnly?: boolean }) {
  const trpc = useTRPC();
  const operator = useQuery(trpc.system.operator.queryOptions());
  if (operator.data?.isOperationsMember !== false) return null;
  return (
    <>
      <TeamStandingBanner />
      {standingOnly ? null : (
        <>
          <RegionBreakerBanner />
          <EventsHealthBanner />
          <DeliverabilityBanner />
        </>
      )}
    </>
  );
}
