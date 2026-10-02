import { SESv2Client, SendEmailCommand, type SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import {
  MailboxSendRejectedError,
  MailboxSendDeferredError,
  type MailboxOutboxSender,
  type MailboxTransportMimeAdapter,
  MailboxContentError,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";

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
    throttle?: (region: string) => Promise<void>;
    /** Captured client for offline qualification; production uses the AWS SDK. */
    clientFactory?: (options: SESv2ClientConfig) => MailboxSesClient;
  } = {},
): MailboxOutboxSender {
  const configurationSets = copyConfigurationSets(opts.configurationSets ?? {});
  const clients = new Map<string, MailboxSesClient>();
  return {
    async send(input) {
      const [domain] = await db
        .select({
          region: schema.domains.region,
          status: schema.domains.status,
          configurationSet: schema.domains.sesConfigurationSet,
          address: schema.mailboxes.address,
          suspendedAt: schema.teams.suspendedAt,
          tenantName: schema.teams.sesTenantName,
          tenantAssociatedAt: schema.domains.sesTenantAssociatedAt,
          tenantConfigSet: schema.domains.sesTenantConfigSet,
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
      const configurationSet = configurationSets[domain.region];
      if (!configurationSet) throw new MailboxSendDeferredError();
      // Campaign configuration can enable SES Open/Click body rewriting. Mail
      // always requires its own explicit regional operator configuration.
      if (configurationSet === domain.configurationSet) throw new MailboxSendRejectedError();
      const parsed = await simpleParser(input.raw, { skipImageLinks: true, skipTextToHtml: true });
      // Includes configuration/authorization overrides and message tags used by
      // acceptance evidence. No X-SES-* header is a private Mail feature.
      if (parsed.headerLines.some((line) => line.key.toLowerCase().startsWith("x-ses-")))
        throw new MailboxSendRejectedError();
      if (opts.exhausted?.(domain.region)) throw new MailboxSendDeferredError();
      await opts.throttle?.(domain.region);
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
      const tenantName =
        domain.tenantAssociatedAt &&
        domain.tenantName &&
        domain.tenantConfigSet === configurationSet
          ? domain.tenantName
          : undefined;
      let response;
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
