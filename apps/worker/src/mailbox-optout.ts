import { env, unsubscribeBaseUrl } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { simpleParser } from "mailparser";

export { simpleParser as parseMailboxComplianceMime } from "mailparser";

import { validateMailboxOptout } from "../../../packages/core/src/mailbox-optout.js";
import {
  type MailboxOutboxSender,
  MailboxSendDeferredError,
} from "../../../packages/core/src/mailbox-transport.js";
export async function mailboxAzureCompliance(
  db: Db,
  input: Parameters<MailboxOutboxSender["send"]>[0],
) {
  try {
    const parsed = await simpleParser(input.raw, {
      skipImageLinks: true,
      skipTextToHtml: true,
      skipHtmlToText: true,
    });
    if (
      parsed.headerLines.filter((h) => h.key === "from").length !== 1 ||
      parsed.from?.value.length !== 1 ||
      parsed.from.value[0]?.address?.toLowerCase() !== input.from.toLowerCase() ||
      parsed.headerLines.some((h) => h.key === "sender" || h.key.startsWith("resent-"))
    )
      throw new Error("mailbox_identity_invalid");
    return await validateMailboxOptout(
      db,
      input.teamId,
      [...input.to, ...input.cc, ...input.bcc],
      {
        text: parsed.text ?? "",
        html: typeof parsed.html === "string" ? parsed.html : null,
        headerLines: parsed.headerLines,
      },
      {
        baseUrl: unsubscribeBaseUrl() ?? "",
        masterKey: Buffer.from(env.MASTER_ENCRYPTION_KEY ?? "", "base64"),
      },
    );
  } catch {
    throw new MailboxSendDeferredError();
  }
}
