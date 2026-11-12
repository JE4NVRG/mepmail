import { parseSendingProviderPolicy } from "@millionsend/core";
import { getAccountOverview, type SesAccountClient } from "@millionsend/ses";
import {
  assertMailboxSesOutboundTopics,
  parseMailboxSesOutboundRegions,
  resolveMailboxSesOutboundRegion,
} from "../../../worker/src/mailbox-outbound-region";

export interface PresentationDomain {
  id: string;
  teamId: string;
  name: string;
  region: string;
  status: string;
  relayEnabledAt: Date | null;
}

/** Presentation-only cache; a failed refresh cannot retain a stale healthy answer. */
export function createRegionalSendingStatusProbe(client: (region: string) => SesAccountClient) {
  const cache = new Map<
    string,
    { at: number; value: Promise<{ production: boolean; sendingHealthy: boolean }> }
  >();
  return (
    region: string,
    configured: boolean,
  ): Promise<{ production: boolean; sendingHealthy: boolean }> => {
    if (!configured) return Promise.resolve({ production: false, sendingHealthy: false });
    const prior = cache.get(region);
    if (prior && Date.now() - prior.at < 60_000) return prior.value;
    const value = getAccountOverview(client(region)).then(
      (v) => ({
        production: v.productionAccess,
        sendingHealthy:
          v.enforcementStatus === "HEALTHY" &&
          v.sendingEnabled &&
          v.productionAccess &&
          v.quota.max24h > v.quota.sentLast24h &&
          v.quota.maxSendRate > 0,
      }),
      () => ({ production: false, sendingHealthy: false }),
    );
    cache.set(region, { at: Date.now(), value });
    return value;
  };
}
export function createRegionalSendingProbe(client: (region: string) => SesAccountClient) {
  const probe = createRegionalSendingStatusProbe(client);
  return async (region: string, configured: boolean) =>
    (await probe(region, configured)).sendingHealthy;
}

export function sesPresentationPermitted(
  teamId: string,
  raw: string | undefined,
  messageClass?: "transactional" | "campaign",
): boolean {
  try {
    const p = parseSendingProviderPolicy(raw);
    if (p?.paused || p?.restoration || (p?.allowedTeamIds && !p.allowedTeamIds.includes(teamId)))
      return false;
    return (messageClass ? [messageClass] : ["transactional", "campaign"]).some(
      (kind) =>
        (p?.teams?.[teamId]?.[kind as "transactional" | "campaign"] ??
          p?.defaults?.[kind as "transactional" | "campaign"] ??
          "ses") === "ses",
    );
  } catch {
    return false;
  }
}

/** No private bindings, other-team records or provider/account diagnostics leave this helper. */
export async function teamHasHealthySesRoute(input: {
  teamId: string;
  domains: readonly PresentationDomain[];
  nativeDomainIds: ReadonlySet<string>;
  nativePermitted?: boolean;
  bindingsRaw: string | undefined;
  topics: readonly string[];
  healthy: (region: string) => Promise<boolean>;
}): Promise<boolean> {
  try {
    const bindings = parseMailboxSesOutboundRegions(input.bindingsRaw);
    assertMailboxSesOutboundTopics(bindings, input.topics);
    for (const d of input.domains) {
      if (d.teamId !== input.teamId || d.status !== "verified") continue;
      if (input.nativePermitted !== false && input.nativeDomainIds.has(d.id)) {
        const region = resolveMailboxSesOutboundRegion(bindings, {
          teamId: input.teamId,
          domainId: d.id,
          domain: d.name,
          region: d.region,
        });
        if (await input.healthy(region)) return true;
      }
      if (await input.healthy(d.region)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
