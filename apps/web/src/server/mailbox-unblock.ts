import { env, isCloudDeployment, servedRegions } from "@millionsend/config";
import { type MailboxRegistryActor, unblockMailboxRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import {
  createSesSuppressionClient,
  removeSesBounceSuppression,
  type SesSuppressionClient,
  type SesSuppressionRemoval,
} from "@millionsend/ses";

/**
 * Unblocking a recipient after a hard bounce: the team's own block goes (core), and, on
 * the hosted service, the same bounce is lifted from SES's account-level suppression list
 * in every served region, or SES would still drop the next send. Only when the team had a
 * hard-bounce block of its own, and only a BOUNCE entry: that list is shared by every team.
 */
export async function unblockMailboxRecipientEverywhere(
  db: Db,
  actor: MailboxRegistryActor,
  input: { address: string },
  client: (region: string) => SesSuppressionClient = (region) =>
    createSesSuppressionClient({
      region,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    }),
) {
  const result = await unblockMailboxRecipient(db, actor, input);
  const ses: Record<string, SesSuppressionRemoval> = {};
  if (result.unblocked && isCloudDeployment())
    for (const region of servedRegions())
      ses[region] = await removeSesBounceSuppression(client(region), result.address);
  return { ...result, ses };
}
