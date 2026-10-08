import { SESv2Client, type SESv2ClientConfig, SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  MailboxContentError,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  MailboxSendRejectedError,
  type MailboxTransportMimeAdapter,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { associateTenantResources, ensureTenant, type SesTenantClient } from "@millionsend/ses";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import type { SesSender } from "./handlers/send-email.js";

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
    /**
     * The customer SMTP relay (CUSTOMER_SMTP_RELAY_URL). A mailbox on a domain
     * the operator verified at the relay's provider (domains.relay_enabled_at)
     * sends through it while SES has paused the region, as API mail does.
     */
    relay?: { name: string; sender: SesSender } | undefined;
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
  /**
   * The same raw MIME and envelope over the relay, no SES pacing (the bucket is
   * SES's rate). The relay's explicit SMTP reply says what it did with the
   * message: a failed login or a 4xx reply means it accepted nothing, so the
   * row is retried; a 5xx means it refused it. A timeout or a dropped
   * connection proves nothing and stays ambiguous. Only the codes are logged:
   * a reply can quote a recipient.
   */
  async function relaySend(
    relay: { name: string; sender: SesSender },
    input: Parameters<MailboxOutboxSender["send"]>[0],
    recipients: string[],
  ): Promise<{ messageId: string }> {
    await refuseSesOverrides(input.raw);
    await allowedRecipients(input.teamId, recipients);
    try {
      return await relay.sender.sendRaw({
        raw: input.raw,
        emailId: input.outboxId,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        envelopeFrom: input.from,
      });
    } catch (error) {
      const e = error as { code?: unknown; responseCode?: unknown };
      console.warn(
        `mailbox.send: SMTP relay ${relay.name} failed (${String(e.code ?? "error")} ${String(e.responseCode ?? "-")})`,
      );
      if (e.code === "EAUTH") throw new MailboxSendDeferredError();
      if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode < 600)
        throw e.responseCode < 500
          ? new MailboxSendDeferredError()
          : new MailboxSendRejectedError();
      throw error;
    }
  }
  return {
    async send(input) {
      // Capture the same MIME/envelope whose recipient permits are reserved below.
      input = {
        ...input,
        raw: Buffer.from(input.raw),
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
          and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, input.teamId)),
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
      if (domain.sendReviewAt) throw new MailboxSendDeferredError();
      // While SES has paused the region, a domain the operator verified at the
      // relay's provider leaves through the relay, as the team's API mail does.
      if (opts.relay && domain.relayEnabledAt && opts.paused?.(domain.region) === true)
        return relaySend(opts.relay, input, recipients);
      const configurationSet = configurationSets[domain.region];
      if (!configurationSet) throw new MailboxSendDeferredError();
      // Campaign configuration can enable SES Open/Click body rewriting. Mail
      // always requires its own explicit regional operator configuration.
      if (configurationSet === domain.configurationSet) throw new MailboxSendRejectedError();
      await refuseSesOverrides(input.raw);
      if (opts.exhausted?.(domain.region)) throw new MailboxSendDeferredError();
      try {
        await opts.throttle?.(domain.region, recipientCount);
      } catch {
        // Cancellation or a failed local permit cannot have accepted this message.
        throw new MailboxSendDeferredError();
      }
      if (opts.exhausted?.(domain.region)) throw new MailboxSendDeferredError();
      await allowedRecipients(input.teamId, recipients);
      let client = clients.get(domain.region);
      if (!client) {
        const options: SESv2ClientConfig = {
          region: domain.region,
          maxAttempts: 1,
          ignoreConfiguredEndpointUrls: true,
          requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
        };
        client = opts.clientFactory ? opts.clientFactory(options) : new SESv2Client(options);
        clients.set(domain.region, client);
      }
      const tenantName = await sendingTenant(client, domain, configurationSet);
      let response: Awaited<ReturnType<MailboxSesClient["send"]>>;
      try {
        response = await client.send(
          new SendEmailCommand({
            FromEmailAddress: input.from,
            Content: { Raw: { Data: input.raw } },
            Destination: { ToAddresses: input.to, CcAddresses: input.cc, BccAddresses: input.bcc },
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
        const name = error instanceof Error ? error.name : "";
        if (
          [
            "MessageRejected",
            "MessageRejectedException",
            "BadRequestException",
            "AccountSuspendedException",
            "SendingPausedException",
            "MailFromDomainNotVerifiedException",
          ].includes(name)
        )
          throw new MailboxSendRejectedError();
        throw error;
      }
      if (!response.MessageId) throw new Error("mailbox_provider_unknown");
      return { messageId: response.MessageId };
    },
  };
}
