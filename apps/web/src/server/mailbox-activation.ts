import { resolveMx } from "node:dns/promises";
import { env } from "@millionsend/config";
import {
  type MailboxRegistryActor,
  MailboxRegistryError,
  mailboxDomainLock,
  mailboxServiceEntitlement,
  withMailboxRegistryAdmin,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { mailboxReceivingIdentityVerified } from "@millionsend/ses";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  appendMailboxReceivingRecipients,
  createMailboxProvisioningClient,
  type MailboxProvisioningClient,
  parseMailboxProvisioningConfiguration,
} from "../../../../packages/ses/src/mailbox-provisioning";
import { parseMailboxInboundConfiguration } from "../../../worker/src/mailbox-ingress";

interface ActivationDependencies {
  configuration?: string | undefined;
  inbound?: string | undefined;
  resolveMx?: typeof resolveMx;
  identity?: (domain: string) => Promise<boolean>;
  client?: () => MailboxProvisioningClient;
}
/** Explicit operator configuration is required; missing configuration keeps activation manual. */
export async function activateMailboxReceiving(
  db: Db,
  actor: MailboxRegistryActor,
  domainId: string,
  deps: ActivationDependencies = {},
): Promise<{ state: "not_configured" | "needs_dns" | "confirmed"; added: number }> {
  const config = parseMailboxProvisioningConfiguration(
    deps.configuration ?? process.env.MAILBOX_RECEIVING_PROVISIONING_CONFIG,
  );
  if (!config) return { state: "not_configured", added: 0 };
  const inbound = parseMailboxInboundConfiguration(
    deps.inbound ?? process.env.MAILBOX_INBOUND_CONFIG,
  );
  if (!inbound || inbound.region !== config.region) throw new MailboxRegistryError("invalid");
  const credentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {};
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const service = await mailboxServiceEntitlement(tx, actor.teamId, true);
    if (!service.active || !service.resourcePolicyActive || !service.plan)
      throw new MailboxRegistryError("forbidden");
    await mailboxDomainLock(tx, domainId);
    const [domain] = await tx
      .select({ name: schema.domains.name, region: schema.domains.region })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, domainId), eq(schema.domains.teamId, actor.teamId)))
      .for("share");
    if (!domain) throw new MailboxRegistryError("not_found");
    if (domain.region !== config.region) throw new MailboxRegistryError("invalid");
    const allocation = tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.teamId, actor.teamId))
      .orderBy(asc(schema.mailboxes.createdAt), asc(schema.mailboxes.id));
    const licensed = new Set(
      (await (service.unlimitedSeats ? allocation : allocation.limit(service.plan.seats))).map(
        (x) => x.id,
      ),
    );
    const boxes = await tx
      .select({
        id: schema.mailboxes.id,
        address: schema.mailboxes.address,
        ownerUserId: schema.mailboxes.ownerUserId,
        membershipId: schema.mailboxes.ownerMembershipId,
      })
      .from(schema.mailboxes)
      .where(
        and(
          eq(schema.mailboxes.teamId, actor.teamId),
          eq(schema.mailboxes.domainId, domainId),
          eq(schema.mailboxes.status, "planned"),
        ),
      )
      .for("share");
    const owners = await tx
      .select({ id: schema.teamMembers.id, userId: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, actor.teamId))
      .for("share");
    const recipients = boxes
      .filter(
        (box) =>
          licensed.has(box.id) &&
          owners.some((owner) => owner.id === box.membershipId && owner.userId === box.ownerUserId),
      )
      .map((box) => box.address);
    if (!recipients.length) throw new MailboxRegistryError("forbidden");
    if (recipients.some((x) => x.split("@")[1] !== domain.name.toLowerCase()))
      throw new MailboxRegistryError("invalid");
    const [mx, identity] = await Promise.all([
      (deps.resolveMx ?? resolveMx)(domain.name),
      deps.identity
        ? deps.identity(domain.name)
        : mailboxReceivingIdentityVerified({
            ...credentials,
            region: config.region,
            domain: domain.name,
          }),
    ]);
    const expected = "inbound-smtp.us-east-1.amazonaws.com";
    if (
      !identity ||
      !mx.length ||
      mx.some((x) => x.exchange.toLowerCase().replace(/\.$/, "") !== expected)
    )
      return { state: "needs_dns", added: 0 };
    // One executor across Web replicas; preserves the same global SES recipient set.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mailbox-receiving-provisioning'))`);
    const result = await appendMailboxReceivingRecipients(
      deps.client
        ? deps.client()
        : createMailboxProvisioningClient({ region: config.region, ...credentials }),
      config,
      recipients,
    );
    return { state: "confirmed", added: result.added };
  });
}
