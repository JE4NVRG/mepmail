import { env } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import {
  createSesv2Client,
  deleteDomainIdentity,
  deleteTenant,
  disassociateIdentity,
} from "@millionsend/ses";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/** The SES side of a suspension, injectable so tests observe it without AWS. */
export interface SuspensionSesDeps {
  /** `tenant` set = the identity is associated with the team's tenant and must be detached first. */
  deleteIdentity(domain: {
    name: string;
    region: string;
    tenant?: string | undefined;
  }): Promise<void>;
  /** Drops the team's tenant in one region; a tenant already gone is fine. */
  deleteTenant(params: { tenantName: string; region: string }): Promise<void>;
}

const clientFor = (region: string) =>
  createSesv2Client({
    region,
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : {}),
  });

const defaultDeps: SuspensionSesDeps = {
  deleteIdentity: async ({ name, region, tenant }) => {
    const client = clientFor(region);
    if (tenant) await disassociateIdentity(client, { tenantName: tenant, region, identity: name });
    try {
      await deleteDomainIdentity(client, { domain: name });
    } catch (error) {
      if ((error as { name?: string }).name !== "NotFoundException") throw error;
    }
  },
  deleteTenant: ({ tenantName, region }) => deleteTenant(clientFor(region), { tenantName }),
};

let override: SuspensionSesDeps | null = null;

/** Tests swap the SES side; null restores AWS. */
export function setSuspensionSesDeps(deps: SuspensionSesDeps | null): void {
  override = deps;
}

export interface SendingAccessCut {
  apiKeys: number;
  agentKeys: number;
  parkedCanceled: number;
  domains: { name: string; region: string; removed: boolean }[];
}

/**
 * A suspension cuts every path the team could send through, not only the
 * flag the send lanes read (AWS Trust and Safety, case 179139014800418):
 * its API keys (HTTP and SMTP authenticate with them), Correio agent keys
 * and OAuth grants are revoked; its domains stop being verified and leave
 * SES (tenant first), so the sending identity is gone from the account. A
 * phishing suspension also cancels the team's parked mail. Reinstating
 * restores none of it: the owner mints new keys and adds the domains again.
 * The database cut commits first; an SES failure is reported, never undone.
 */
export async function cutTeamSendingAccess(
  db: Db,
  team: { id: string; sesTenantName: string | null },
  options: { cancelParked: boolean; now?: Date },
): Promise<SendingAccessCut> {
  const now = options.now ?? new Date();
  const ses = override ?? defaultDeps;
  const result = await db.transaction(async (tx) => {
    const apiKeys = await tx
      .update(schema.apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(schema.apiKeys.teamId, team.id), isNull(schema.apiKeys.revokedAt)))
      .returning({ id: schema.apiKeys.id });
    // Correio's tables exist only where its migrations ran.
    const [correio] = await tx
      .select({ installed: sql<boolean>`to_regclass('public.mailbox_agent_keys') is not null` })
      .from(sql`(select 1) as mailbox_extension`);
    const agentKeys = correio?.installed
      ? await tx
          .update(schema.mailboxAgentKeys)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.mailboxAgentKeys.teamId, team.id),
              isNull(schema.mailboxAgentKeys.revokedAt),
            ),
          )
          .returning({ id: schema.mailboxAgentKeys.id })
      : [];
    await tx
      .delete(schema.oauthAccessToken)
      .where(eq(schema.oauthAccessToken.referenceId, team.id));
    await tx
      .delete(schema.oauthRefreshToken)
      .where(eq(schema.oauthRefreshToken.referenceId, team.id));
    await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.referenceId, team.id));
    const parked = options.cancelParked
      ? await tx
          .update(schema.emails)
          .set({ latestStatus: "canceled" })
          .where(
            and(
              eq(schema.emails.teamId, team.id),
              inArray(schema.emails.latestStatus, ["queued_quota", "queued"]),
              isNull(schema.emails.sentAt),
            ),
          )
          .returning({ id: schema.emails.id })
      : [];
    const domains = await tx
      .update(schema.domains)
      .set({ status: "failed", sesTenantAssociatedAt: null, sesTenantConfigSet: null })
      .where(eq(schema.domains.teamId, team.id))
      .returning({
        name: schema.domains.name,
        region: schema.domains.region,
      });
    return { apiKeys: apiKeys.length, agentKeys: agentKeys.length, parked: parked.length, domains };
  });
  // The tenant goes first: SES refuses to delete an identity a tenant still
  // holds. A failed tenant delete falls back to detaching each identity.
  if (team.sesTenantName) {
    for (const region of new Set(result.domains.map((d) => d.region))) {
      try {
        await ses.deleteTenant({ tenantName: team.sesTenantName, region });
      } catch (error) {
        console.error(`suspension: SES tenant (${region}) not removed`, error);
      }
    }
  }
  const removed: SendingAccessCut["domains"] = [];
  for (const domain of result.domains) {
    try {
      await ses.deleteIdentity({
        name: domain.name,
        region: domain.region,
        tenant: team.sesTenantName ?? undefined,
      });
      removed.push({ ...domain, removed: true });
    } catch (error) {
      console.error(
        `suspension: SES identity ${domain.name} (${domain.region}) not removed`,
        error,
      );
      removed.push({ ...domain, removed: false });
    }
  }
  return {
    apiKeys: result.apiKeys,
    agentKeys: result.agentKeys,
    parkedCanceled: result.parked,
    domains: removed,
  };
}
