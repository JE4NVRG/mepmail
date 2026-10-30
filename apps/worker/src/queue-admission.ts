import { extractAddrSpec } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import {
  EMAIL_SEND_PRIORITY,
  type EmailSendPriority,
  type EnqueueEmailSends,
} from "@millionsend/queue";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { campaignSendWindowOpen } from "../../../packages/core/src/campaign-send-window.js";
import {
  resolveSendingProvider,
  type SendingProviderPolicy,
} from "../../../packages/core/src/sending-provider-policy.js";

export interface QueueAdmission {
  now?: (() => Date) | undefined;
  policy: SendingProviderPolicy | null;
  azureAvailable: boolean;
}

/** Narrow SQL probe: never walk the customer's unrelated parked backlog. */
export function queueAdmissionScope(admission?: QueueAdmission): SQL | undefined {
  const policy = admission?.policy;
  if (!policy?.restoration) return undefined;
  if (policy.paused || !admission?.azureAvailable) return sql`false`;
  const e = schema.emails;
  const scopes: SQL[] = [];
  for (const [teamId, own] of Object.entries(policy.restoration.teams)) {
    if (!policy.allowedTeamIds?.includes(teamId)) continue;
    scopes.push(sql`${e.teamId} = ${teamId} and ${e.createdAt} >= ${own.notBefore}::timestamptz`);
  }
  const campaign = policy.restoration.campaignCohort;
  if (
    campaign &&
    policy.allowedTeamIds?.includes(campaign.teamId) &&
    campaignSendWindowOpen(campaign.sendWindow, admission?.now?.())
  ) {
    for (const message of campaign.messages) {
      scopes.push(sql`${e.teamId} = ${campaign.teamId} and ${e.id} = ${message.emailId}
        and ${e.createdAt} = ${message.createdAt}::timestamptz
        and clock_timestamp() >= ${campaign.sendWindow.startsAt}::timestamptz
        and clock_timestamp() < ${campaign.sendWindow.endsAt}::timestamptz
        and not exists (select 1 from ${schema.auditLog} a
          where a.team_id = ${campaign.teamId} and a.action = 'sending.restoration_campaign_claimed'
          and a.data->>'emailId' = ${message.emailId})`);
    }
  }
  return and(
    scopes.length ? or(...scopes) : sql`false`,
    isNull(e.sentAt),
    isNull(e.sesMessageId),
    isNull(e.broadcastId),
    isNull(e.contactId),
    isNull(e.topicId),
  );
}

type QueueEmail = Pick<
  typeof schema.emails.$inferSelect,
  | "id"
  | "teamId"
  | "createdAt"
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "sentAt"
  | "sesMessageId"
  | "latestStatus"
  | "broadcastId"
  | "contactId"
  | "topicId"
>;
/** Prospective admission only; the send lane still rechecks every live guard. */
export function queueEmailAdmitted(email: QueueEmail, admission?: QueueAdmission): boolean {
  const policy = admission?.policy;
  if (!policy?.restoration) return true;
  if (
    !["queued", "queued_quota"].includes(email.latestStatus) ||
    email.sentAt !== null ||
    email.sesMessageId !== null ||
    email.broadcastId ||
    email.contactId ||
    email.topicId
  )
    return false;
  return (
    resolveSendingProvider(policy, {
      now: admission?.now?.(),
      teamId: email.teamId,
      emailId: email.id,
      messageClass:
        policy.restoration.campaignCohort?.teamId === email.teamId ? "campaign" : "transactional",
      createdAt: email.createdAt,
      fromAddress: extractAddrSpec(email.from).toLowerCase(),
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      sentAt: email.sentAt,
      sesMessageId: email.sesMessageId,
      // A parked row is evaluated as the proposed queued state, without mutating it.
      latestStatus: "queued",
      legacyProvider: "ses",
      availableProviders: new Set(admission?.azureAvailable ? ["azure_smtp"] : []),
    }).kind === "selected"
  );
}

/** All enqueue/reconcile/reschedule callers use the same admission boundary. */
export function createAdmittedEnqueue(
  db: Db,
  admission: QueueAdmission,
  queue: {
    sendMany: (
      name: "email.send",
      rows: {
        payload: { emailId: string };
        dedupeKey: string;
        priority: EmailSendPriority;
        startAfter: Date | undefined;
      }[],
    ) => Promise<unknown>;
  },
): EnqueueEmailSends {
  return async (batch) => {
    if (admission.policy?.restoration) {
      const admitted = [];
      for (const request of batch) {
        const [email] = await db
          .select()
          .from(schema.emails)
          .where(and(eq(schema.emails.id, request.emailId), queueAdmissionScope(admission)));
        if (!email || !queueEmailAdmitted(email, admission)) {
          // Never silently acknowledge a drain page that already reserved quota.
          // Its caller compensates the entire failed page; no partial queue write.
          throw new Error("sending_queue_admission_held");
        }
        const campaign = admission.policy.restoration.campaignCohort;
        if (
          campaign?.teamId === email.teamId &&
          request.startAfter &&
          !campaignSendWindowOpen(campaign.sendWindow, request.startAfter)
        ) {
          throw new Error("sending_queue_admission_held");
        }
        admitted.push(request);
      }
      batch = admitted;
    }
    const campaign = admission.policy?.restoration?.campaignCohort;
    if (
      campaign &&
      batch.some((r) => campaign.messages.some((m) => m.emailId === r.emailId)) &&
      !campaignSendWindowOpen(campaign.sendWindow, admission.now?.())
    ) {
      throw new Error("sending_queue_admission_held");
    }
    if (batch.length === 0) return;
    await queue.sendMany(
      "email.send",
      batch.map(({ emailId, startAfter, priority }) => ({
        payload: { emailId },
        dedupeKey: emailId,
        priority: admission.policy?.restoration?.campaignCohort?.messages.some(
          (m) => m.emailId === emailId,
        )
          ? EMAIL_SEND_PRIORITY.bulk
          : (priority ?? EMAIL_SEND_PRIORITY.bulk),
        startAfter,
      })),
    );
  };
}
