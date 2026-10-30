import type { Db } from "@millionsend/db";
import {
  buildAzureRecipientOptoutUrl,
  verifyAzureRecipientOptoutToken,
} from "./azure-recipient-optout.js";
import { parseSendingProviderPolicy } from "./sending-provider-policy.js";
import { findSuppressed, hashRecipient } from "./suppressions.js";
import { deriveUnsubscribeKey } from "./unsubscribe.js";

export type MailboxOptoutConfig = { baseUrl: string; masterKey: Buffer };
/** Composition is not delivery authorization: other providers and multi-recipient
 * drafts stay editable. The Azure worker independently refuses noncompliant MIME. */
export function mailboxDraftNeedsAzureOptout(
  rawPolicy: string | undefined,
  teamId: string,
  address: string,
  origin: string,
  recipients: readonly string[],
): boolean {
  const policy = parseSendingProviderPolicy(rawPolicy);
  const cohort = policy?.restoration?.teams[teamId];
  return (
    origin !== "external" &&
    !!cohort &&
    cohort.senders.some((sender) => sender.toLowerCase() === address.toLowerCase()) &&
    new Set(recipients.map(hashRecipient)).size === 1
  );
}

function checked(config: MailboxOptoutConfig) {
  if (config.masterKey.length !== 32) throw new Error("mailbox_optout_unavailable");
  return deriveUnsubscribeKey(config.masterKey);
}
export function mailboxOptoutFooter(url: string) {
  return {
    text: `\n\nStop all Azure-delivered messages from this team (including service messages): ${url}`,
    html: `<p>Stop all Azure-delivered messages from this team (including service messages): <a href="${url}">Unsubscribe</a></p>`,
  };
}
/** Creates no contact and grants no marketing consent. */
export async function prepareMailboxOptout(
  db: Db,
  teamId: string,
  recipients: readonly string[],
  config: MailboxOptoutConfig,
  options: { draftOnly?: boolean } = {},
) {
  const key = checked(config);
  const unique = [...new Set(recipients.map((r) => r.toLowerCase()))];
  // Shared MIME cannot safely expose different recipients' bearer tokens.
  if (unique.length !== 1) throw new Error("mailbox_optout_single_recipient_required");
  const recipient = unique[0]!;
  if (!options.draftOnly && (await findSuppressed(db, teamId, [recipient])).size)
    throw new Error("mailbox_optout_suppressed");
  const url = buildAzureRecipientOptoutUrl({
    teamId,
    recipient,
    secretKey: key,
    baseUrl: config.baseUrl,
  });
  // Header retained on wire/history; body link remains independently mandatory.
  return { url, ...mailboxOptoutFooter(url), headers: { "List-Unsubscribe": `<${url}>` } };
}
/** Returns only exact authenticated system footer metadata for classification.
 * No wire/body mutation, no marketing exemption; all author content is screened. */
export async function validateMailboxOptout(
  db: Db,
  teamId: string,
  recipients: readonly string[],
  content: {
    text: string;
    html: string | null;
    headerLines: readonly { key: string; line: string }[];
  },
  config: MailboxOptoutConfig,
) {
  const key = checked(config);
  const headers = content.headerLines.filter((h) => h.key.toLowerCase() === "list-unsubscribe");
  if (headers.length !== 1) throw new Error("mailbox_optout_invalid");
  const value = headers[0]!.line
    .slice(headers[0]!.line.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
  if (!value.startsWith("<") || !value.endsWith(">")) throw new Error("mailbox_optout_invalid");
  const url = new URL(value.slice(1, -1));
  const token = url.pathname.split("/").at(-1)!;
  const parsed = verifyAzureRecipientOptoutToken(token, key);
  const unique = [...new Set(recipients.map((r) => hashRecipient(r)))];
  if (
    !parsed ||
    parsed.teamId !== teamId ||
    unique.length !== 1 ||
    parsed.recipientHash !== unique[0] ||
    url.href !==
      buildAzureRecipientOptoutUrl({
        teamId,
        recipient: recipients[0]!,
        secretKey: key,
        baseUrl: config.baseUrl,
      })
  )
    throw new Error("mailbox_optout_invalid");
  // Default false intentionally blocks one_click_unsubscribe for transactional too.
  if ((await findSuppressed(db, teamId, recipients)).size)
    throw new Error("mailbox_optout_suppressed");
  const footer = mailboxOptoutFooter(url.href);
  const text = content.text.replace(/\r\n/g, "\n").trimEnd();
  if (
    !text.endsWith(footer.text) ||
    (content.html !== null && !content.html.trimEnd().endsWith(footer.html))
  )
    throw new Error("mailbox_optout_missing_body_link");
  // Quoted canonical footers are still provider-generated controls, not author
  // marketing content. Remove only the exact signed team+recipient footer in
  // this derived analysis; the approved wire MIME and Sent history never change.
  const canonicalLine = footer.text.trimStart();
  const label = canonicalLine.slice(0, canonicalLine.length - url.href.length).trimEnd();
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Require quote markers on EVERY folded line. Only whitespace/folding may
  // differ; label and URL remain exact. Never strip author prose.
  function stripQuoted(value: string, html: boolean): string {
    const separator = html ? "<br\\s*/?>" : "\\n";
    const marker = html ? "&gt;" : ">";
    const prefix = `(?:[ \\t]*${marker})+[ \\t]*`;
    const gap = `(?:[ \\t]+|[ \\t]*(?:${separator})${prefix})`;
    const words = label.split(" ").map(escapeRegex).join(gap);
    const literalUrl = escapeRegex(url.href);
    const target = html ? `&lt;${literalUrl}&gt;` : `<${literalUrl}>`;
    const control = `${words}${gap}(?:${literalUrl}|Unsubscribe${gap}${target})`;
    const pattern = new RegExp(
      `(^|${separator})(${prefix})${control}(?=[ \\t]*(?:${separator}|$|</p>))`,
      "g",
    );
    return value.replace(pattern, "$1");
  }
  const authorText = stripQuoted(text.slice(0, -footer.text.length), false);
  const authorHtml =
    content.html === null
      ? null
      : content.html
          .trimEnd()
          .slice(0, -footer.html.length)
          // Editor-serialized quoted controls only. Leave all other quote/HTML bytes.
          .replace(
            /(<blockquote\b[^<>]*>)([\s\S]*?)(<\/blockquote\s*>)/gi,
            (_match, open: string, body: string, close: string) =>
              open + stripQuoted(body.split(footer.html).join(""), true) + close,
          );
  return {
    text: authorText,
    html: authorHtml,
    headers: Object.fromEntries(
      content.headerLines
        .filter((h) => h.key.toLowerCase() !== "list-unsubscribe")
        .map((h) => [h.key, h.line]),
    ),
  };
}
