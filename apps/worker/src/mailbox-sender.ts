import { SESv2Client, type SESv2ClientConfig, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  checkSignupSend,
  evaluateEmailInsights,
  MailboxContentError,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  MailboxSendRejectedError,
  type MailboxTransportMimeAdapter,
  parseSingleSender,
  resolveSendingProvider,
  type SendingProviderPolicy,
  stripMailboxPrivateHeaders,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { associateTenantResources, ensureTenant, type SesTenantClient } from "@millionsend/ses";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import {
  campaignMessage,
  checkCampaignMessage,
} from "../../../packages/core/src/campaign-consent.js";
import { screenPreSendContent } from "../../../packages/core/src/pre-send-content-policy.js";
import { releaseQuota, reserveQuota } from "../../../packages/core/src/quota.js";
import { isSendReviewHeld } from "../../../packages/core/src/send-review.js";
import { applySenderProbationQuota } from "../../../packages/core/src/sender-probation.js";
import { utcDay } from "../../../packages/core/src/utc-day.js";
import type { SesSender } from "./handlers/send-email.js";
import { isSesEnforcementRefusal, type SesQuotaGate } from "./handlers/ses-quota.js";
import type { SesFailover } from "./ses-failover.js";

export const mailboxWorkerMime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    if (
      parsed.headerLines.filter((line) => line.key === "from").length !== 1 ||
      parsed.from?.value.length !== 1 ||
      !parsed.from.value[0]?.address
    )
      throw new MailboxContentError("invalid");
    const addresses = (value: typeof parsed.to) =>
      (Array.isArray(value) ? value : value ? [value] : [])
        .flatMap((v) => v.value)
        .map((v) => v.address)
        .filter((v): v is string => !!v);
    return {
      from: parsed.from.value[0].address,
      to: addresses(parsed.to),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
async function checkMailboxContent(
  db: Db,
  input: Parameters<MailboxOutboxSender["send"]>[0],
): Promise<void> {
  try {
    const parsed = await simpleParser(input.raw, { skipImageLinks: true, skipTextToHtml: true });
    if (
      (
        await screenPreSendContent(db, {
          teamId: input.teamId,
          from: parsed.from?.text ?? input.from,
          subject: parsed.subject ?? "",
          html: typeof parsed.html === "string" ? parsed.html : null,
          text: parsed.text ?? null,
        })
      ).action === "hold"
    )
      throw new MailboxSendDeferredError();
  } catch {
    throw new MailboxSendDeferredError();
  }
  try {
    const parsed = await simpleParser(input.raw, { skipImageLinks: true, skipTextToHtml: true });
    const consent = await checkCampaignMessage(db, {
      teamId: input.teamId,
      from: parsed.from?.text ?? input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: parsed.subject ?? "",
      html: typeof parsed.html === "string" ? parsed.html : null,
      text: parsed.text ?? null,
      headers: Object.fromEntries(parsed.headerLines.map((line) => [line.key, line.line])),
    });
    if (!consent.allowed) throw new MailboxSendDeferredError();
  } catch {
    throw new MailboxSendDeferredError();
  }
}

// Private identity marker, not a client-declared option. Outer router and SES
// share one reservation using the existing Send day ledger, not a new counter.
const probationReserved = new WeakSet<object>();
function withMailboxProbation(
  db: Db,
  sender: MailboxOutboxSender,
  isCloud: boolean,
): MailboxOutboxSender {
  return {
    async send(input) {
      if (!isCloud || probationReserved.has(input)) return sender.send(input);
      await checkMailboxContent(db, input);
      const [team] = await db
        .select({
          suspendedAt: schema.teams.suspendedAt,
          sendReviewAt: schema.teams.sendReviewAt,
          sendReviewClearedAt: schema.teams.sendReviewClearedAt,
        })
        .from(schema.teams)
        .where(eq(schema.teams.id, input.teamId));
      if (
        !team ||
        team.suspendedAt ||
        isSendReviewHeld(team) ||
        !(await checkSignupSend(db, input.teamId, [...input.to, ...input.cc, ...input.bcc])).allowed
      )
        throw new MailboxSendDeferredError();
      const quota = await applySenderProbationQuota(db, input.teamId, { kind: "none" }, true);
      const count = new Set([...input.to, ...input.cc, ...input.bcc].map((s) => s.toLowerCase()))
        .size;
      const at = new Date();
      const day = utcDay(at);
      if (!(await reserveQuota(db, { teamId: input.teamId, count, quota, at, day })).reserved)
        throw new MailboxSendDeferredError();
      probationReserved.add(input);
      try {
        await checkMailboxContent(db, input);
        return await sender.send(input);
      } catch (error) {
        // Unknown outcome keeps the charge. Only a proven non-acceptance releases.
        if (error instanceof MailboxSendDeferredError || error instanceof MailboxSendRejectedError)
          await releaseQuota(db, { teamId: input.teamId, count, quota, at, day });
        throw error;
      } finally {
        probationReserved.delete(input);
      }
    },
  };
}

/** Wrap the OUTERMOST Correio router so connected external SMTP is covered too. */
export function createMailboxContentPolicySender(
  db: Db,
  sender: MailboxOutboxSender,
  isCloud: boolean,
  policy: SendingProviderPolicy | null = null,
): MailboxOutboxSender {
  return {
    async send(input) {
      input = {
        ...input,
        raw: Buffer.from(input.raw),
        to: [...input.to],
        cc: [...input.cc],
        bcc: [...input.bcc],
      };
      if (isCloud) await checkMailboxContent(db, input);
      if (policy) {
        const parsed = await simpleParser(input.raw, {
          skipImageLinks: true,
          skipTextToHtml: true,
        });
        const from = parsed.from?.text ?? input.from;
        const html = typeof parsed.html === "string" ? parsed.html : null;
        const insight = evaluateEmailInsights({
          html,
          preTrackingHtml: html,
          text: parsed.text ?? null,
          from,
          senderDomain: parseSingleSender(from)?.domain ?? "",
          subject: parsed.subject ?? "",
          finalHeaders: {},
          hasAttachments: parsed.attachments.length > 0,
          replyTo: null,
          isBroadcast: false,
          hasTopic: false,
          tracking: {
            clickEnabled: false,
            openEnabled: false,
            brandedHostUsed: false,
            sharedFallbackUsed: false,
            shippedUntracked: true,
          },
          domainSnapshot: null,
          now: new Date(),
        });
        const [box] = await db
          .select({ origin: schema.mailboxes.origin })
          .from(schema.mailboxes)
          .where(
            and(
              eq(schema.mailboxes.id, input.mailboxId),
              eq(schema.mailboxes.teamId, input.teamId),
            ),
          );
        // Router only exposes its existing adapter. Policy cannot turn on a new
        // relay or reroute SES mail via a connected external identity.
        const provider = box?.origin === "external" ? "customer_smtp" : "ses";
        const route = resolveSendingProvider(policy, {
          teamId: input.teamId,
          messageClass:
            insight.marketing ||
            campaignMessage({
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              subject: parsed.subject,
              html,
              text: parsed.text,
              headers: Object.fromEntries(parsed.headerLines.map((line) => [line.key, line.line])),
            })
              ? "campaign"
              : "transactional",
          legacyProvider: provider,
          availableProviders: new Set(box ? [provider] : []),
        });
        if (route.kind === "held") throw new MailboxSendDeferredError();
      }
      return withMailboxProbation(db, sender, isCloud).send(input);
    },
  };
}

interface MailboxSesClient {
  send(command: SendEmailCommand): Promise<{ MessageId?: string | undefined }>;
}

export type MailboxSesConfigurationSets = Readonly<Record<string, string>>;
const CONFIGURATION_SET_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REGION_NAME = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

function copyConfigurationSets(value: unknown): MailboxSesConfigurationSets {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("mailbox_ses_configuration_sets_invalid");
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(
      ([region, name]) =>
        !REGION_NAME.test(region) || typeof name !== "string" || !CONFIGURATION_SET_NAME.test(name),
    )
  )
    throw new Error("mailbox_ses_configuration_sets_invalid");
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(entries)),
  );
}

/** Includes configuration/authorization overrides and message tags used by
 * acceptance evidence. No X-SES-* header is a private Mail feature.
 */
async function refuseSesOverrides(raw: Buffer): Promise<void> {
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  if (parsed.headerLines.some((line) => line.key.toLowerCase().startsWith("x-ses-")))
    throw new MailboxSendRejectedError();
}

/** Explicit operator JSON: { "us-east-1": "private_mail_events" }.
 * Absence disables sending preflight; malformed configuration fails startup.
 */
export function parseMailboxSesConfigurationSets(
  value?: string,
): MailboxSesConfigurationSets | null {
  if (value === undefined || value.trim() === "") return null;
  if (Buffer.byteLength(value) > 16 * 1024)
    throw new Error("mailbox_ses_configuration_sets_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("mailbox_ses_configuration_sets_invalid");
  }
  return copyConfigurationSets(parsed);
}

/** Separate private correspondence sender: one SDK attempt, no campaign tracking.
 * Stable tags support authenticated evidence after a lost acknowledgement.
 */
export function createMailboxSesSender(
  db: Db,
  opts: {
    /** Cloud-only abuse policy; self-hosted transport contract stays unchanged. */
    isCloud?: boolean;
    configurationSets?: MailboxSesConfigurationSets | null | undefined;
    exhausted?: (region: string) => boolean;
    throttle?: (region: string, recipients: number) => Promise<void>;
    checkRecipients?: (input: {
      teamId: string;
      recipients: readonly string[];
    }) => Promise<boolean>;
    /** Captured client for offline qualification; production uses the AWS SDK. */
    clientFactory?: (options: SESv2ClientConfig) => MailboxSesClient;
    /** SES_TENANTS: also associate the Mail configuration set with the team's tenant. */
    tenants?: boolean;
    /** SES's own pause on the region (EnforcementStatus SHUTDOWN or sending off). */
    paused?: (region: string) => boolean;
    /** Real regional enforcement state and account refresh, not capacity alone. */
    sesQuota?: SesQuotaGate;
    /** Legacy configuration only: an SES account pause never authorizes relay use. */
    relay?: { name: string; sender: SesSender } | undefined;
    /** Legacy configuration only: an SES account pause never authorizes region failover. */
    failover?: SesFailover | undefined;
  } = {},
): MailboxOutboxSender {
  const configurationSets = copyConfigurationSets(opts.configurationSets ?? {});
  const clients = new Map<string, MailboxSesClient>();
  // Region + tenant + Mail configuration set already associated by this process.
  const tenantSets = new Set<string>();
  /** The team's tenant for this send, or none; never fails the send itself. */
  async function sendingTenant(
    client: MailboxSesClient,
    domain: {
      region: string;
      domainName: string;
      tenantName: string | null;
      tenantAssociatedAt: Date | null;
      tenantConfigSet: string | null;
    },
    configurationSet: string,
  ): Promise<string | undefined> {
    if (!domain.tenantAssociatedAt || !domain.tenantName) return undefined;
    if (domain.tenantConfigSet === configurationSet) return domain.tenantName;
    if (!opts.tenants) return undefined;
    const key = `${domain.region}|${domain.tenantName}|${configurationSet}`;
    if (tenantSets.has(key)) return domain.tenantName;
    try {
      // The identity is already in the tenant (domain sync); add the Mail set too.
      // The SDK client sends any SESv2 command; the Mail interface only names SendEmail.
      const tenants = client as unknown as SesTenantClient;
      const { accountId } = await ensureTenant(tenants, { tenantName: domain.tenantName });
      await associateTenantResources(tenants, {
        tenantName: domain.tenantName,
        accountId,
        region: domain.region,
        identity: domain.domainName,
        configurationSet,
      });
      tenantSets.add(key);
      return domain.tenantName;
    } catch {
      // A TenantName needs every referenced resource associated; send untagged instead.
      return undefined;
    }
  }
  async function allowedRecipients(teamId: string, recipients: string[]): Promise<void> {
    const [team] = await db
      .select({
        sendReviewAt: schema.teams.sendReviewAt,
        sendReviewClearedAt: schema.teams.sendReviewClearedAt,
        suspended: schema.teams.suspendedAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    if (
      !team ||
      isSendReviewHeld(team) ||
      team.suspended ||
      !(await checkSignupSend(db, teamId, recipients)).allowed
    ) {
      throw new MailboxSendDeferredError();
    }
    if (!opts.checkRecipients) return;
    let allowed: boolean;
    try {
      allowed = await opts.checkRecipients({ teamId, recipients });
    } catch {
      // A failed lookup is a preflight failure, never evidence of provider acceptance.
      throw new MailboxSendDeferredError();
    }
    if (allowed !== true) throw new MailboxSendRejectedError();
  }
  return withMailboxProbation(
    db,
    {
      async send(input) {
        // Capture the same MIME/envelope whose recipient permits are reserved below. Bcc
        // and the format marker stay on the sealed copies and never leave (SES or relay).
        input = {
          ...input,
          raw: stripMailboxPrivateHeaders(Buffer.from(input.raw)),
          to: [...input.to],
          cc: [...input.cc],
          bcc: [...input.bcc],
        };
        const recipients = [...new Set([...input.to, ...input.cc, ...input.bcc])];
        const recipientCount = recipients.length;
        if (!input.to.length || recipientCount < 1 || recipientCount > 20)
          throw new MailboxSendRejectedError();
        const [domain] = await db
          .select({
            region: schema.domains.region,
            domainName: schema.domains.name,
            status: schema.domains.status,
            configurationSet: schema.domains.sesConfigurationSet,
            address: schema.mailboxes.address,
            suspendedAt: schema.teams.suspendedAt,
            sendReviewAt: schema.teams.sendReviewAt,
            sendReviewClearedAt: schema.teams.sendReviewClearedAt,
            tenantName: schema.teams.sesTenantName,
            tenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
            tenantConfigSet: schema.domains.sesTenantConfigSet,
            relayEnabledAt: schema.domains.relayEnabledAt,
          })
          .from(schema.mailboxes)
          .innerJoin(
            schema.domains,
            and(
              eq(schema.domains.id, schema.mailboxes.domainId),
              eq(schema.domains.teamId, schema.mailboxes.teamId),
            ),
          )
          .innerJoin(schema.teams, eq(schema.teams.id, schema.mailboxes.teamId))
          .where(
            and(
              eq(schema.mailboxes.id, input.mailboxId),
              eq(schema.mailboxes.teamId, input.teamId),
            ),
          );
        if (
          !domain ||
          domain.suspendedAt ||
          domain.status !== "verified" ||
          domain.address !== input.from
        )
          throw new MailboxSendRejectedError();
        // A send-review hold keeps the message for the operator's release, as
        // it keeps the team's API mail.
        if (isSendReviewHeld(domain)) throw new MailboxSendDeferredError();
        if (opts.isCloud) await checkMailboxContent(db, input);
        const accountPaused = () =>
          opts.paused?.(domain.region) === true ||
          opts.sesQuota?.accountPaused?.(domain.region) === true;
        // An SES enforcement stop never authorizes automatic relay/region failover.
        if (accountPaused()) throw new MailboxSendDeferredError();
        const region = domain.region;
        const configurationSet = configurationSets[region];
        if (!configurationSet) throw new MailboxSendDeferredError();
        // Campaign configuration can enable SES Open/Click body rewriting. Mail
        // always requires its own explicit regional operator configuration.
        if (configurationSet === domain.configurationSet) throw new MailboxSendRejectedError();
        await refuseSesOverrides(input.raw);
        if (opts.exhausted?.(region)) throw new MailboxSendDeferredError();
        try {
          await opts.throttle?.(region, recipientCount);
        } catch {
          // Cancellation or a failed local permit cannot have accepted this message.
          throw new MailboxSendDeferredError();
        }
        if (opts.exhausted?.(region)) throw new MailboxSendDeferredError();
        await allowedRecipients(input.teamId, recipients);
        let client = clients.get(region);
        if (!client) {
          const options: SESv2ClientConfig = {
            region,
            maxAttempts: 1,
            ignoreConfiguredEndpointUrls: true,
            requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
          };
          client = opts.clientFactory ? opts.clientFactory(options) : new SESv2Client(options);
          clients.set(region, client);
        }
        const tenantName = await sendingTenant(client, domain, configurationSet);
        // Tenant provisioning can wait on the network after the first gate.
        // A restriction introduced during that wait still precedes the send.
        await allowedRecipients(input.teamId, recipients);
        if (accountPaused()) throw new MailboxSendDeferredError();
        if (opts.isCloud) await checkMailboxContent(db, input);
        let response: Awaited<ReturnType<MailboxSesClient["send"]>>;
        try {
          response = await client.send(
            new SendEmailCommand({
              FromEmailAddress: input.from,
              Content: { Raw: { Data: input.raw } },
              Destination: {
                ToAddresses: input.to,
                CcAddresses: input.cc,
                BccAddresses: input.bcc,
              },
              EmailTags: [
                { Name: "mepmail_outbox_id", Value: input.outboxId },
                { Name: "mepmail_attempt_id", Value: input.attemptId },
              ],
              ConfigurationSetName: configurationSet,
              ...(tenantName ? { TenantName: tenantName } : {}),
            }),
          );
        } catch (error) {
          // Only explicit documented SES refusals prove there was no acceptance.
          if (await isSesEnforcementRefusal(error, opts.sesQuota, region))
            throw new MailboxSendDeferredError();
          const name = error instanceof Error ? error.name : "";
          if (
            [
              "MessageRejected",
              "MessageRejectedException",
              "BadRequestException",
              "MailFromDomainNotVerifiedException",
            ].includes(name)
          )
            throw new MailboxSendRejectedError();
          throw error;
        }
        if (!response.MessageId) throw new Error("mailbox_provider_unknown");
        return { messageId: response.MessageId };
      },
    },
    opts.isCloud ?? false,
  );
}
