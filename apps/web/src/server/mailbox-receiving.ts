import { resolveMx } from "node:dns/promises";
import { env } from "@millionsend/config";
import type { MailboxReceivingDeps } from "@millionsend/core";
import {
  createMailboxReceivingRuleClient,
  mailboxReceivingIdentityVerified,
  mailboxReceivingRuleFacts,
  readMailboxReceivingRules,
} from "@millionsend/ses";
import { parseMailboxInboundConfiguration } from "../../../worker/src/mailbox-ingress";

/** Existing private ingress only. A sending region never enables receiving by inference. */
export function mailboxReceivingDeps(): MailboxReceivingDeps {
  let route: ReturnType<typeof parseMailboxInboundConfiguration> = null;
  try {
    route = parseMailboxInboundConfiguration(process.env.MAILBOX_INBOUND_CONFIG);
  } catch {
    /* fail closed */
  }
  const approved = route;
  const credentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {};
  // One live read per request; share across domain checks without cross-request stale caches.
  let rules: Promise<unknown> | undefined;
  return {
    configuration(domain) {
      if (!approved || domain.region !== approved.region || approved.region !== "us-east-1")
        return null;
      return { mxExchange: "inbound-smtp.us-east-1.amazonaws.com", ingressEnabled: true };
    },
    resolveMx,
    async observe(domain) {
      if (!approved || domain.region !== approved.region) return null;
      if (!rules)
        rules = readMailboxReceivingRules(
          createMailboxReceivingRuleClient({ region: approved.region, ...credentials }),
        );
      const [output, identity] = await Promise.all([
        rules,
        mailboxReceivingIdentityVerified({
          region: approved.region,
          domain: domain.name,
          ...credentials,
        }),
      ]);
      if (!identity) return null;
      return {
        domainId: domain.id,
        teamId: domain.teamId,
        domainName: domain.name,
        region: domain.region,
        checkedAt: new Date(),
        ...mailboxReceivingRuleFacts(output, domain.name, approved),
      };
    },
  };
}
