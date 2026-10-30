import { createHash } from "node:crypto";
import { hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { auditLog } from "@millionsend/db/schema";
import { eq } from "drizzle-orm";
import {
  acceptMailboxOutbox,
  MAILBOX_AZURE_RESOURCE,
  mailboxRecipientHashFromPublicHash,
} from "../../../../packages/core/src/mailbox-transport.js";
import { processProviderEvent } from "../../../../packages/core/src/process-provider-event.js";
import {
  AZURE_EMAIL_SOURCE,
  type AzureDeliveryAudit,
  AzureEventConflict,
  type AzureEventStore,
} from "./azure-email-events.js";

export const AZURE_EVENT_AUDIT_ACTION = "pilot.azure_email_delivery_report";

/** Domain-separated UUIDv8, deterministic across restarts, independent of payload/team. */
export function azureEventAuditId(eventId: string): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(["mepmail.azure-email-event.v1", AZURE_EMAIL_SOURCE.toLowerCase(), eventId]),
    )
    .digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x80;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function metadata(event: AzureDeliveryAudit): Record<string, unknown> {
  // Explicit projection: never persist a spread of provider data or raw recipients.
  return {
    provider: event.provider,
    messageId: event.messageId,
    eventId: event.eventId,
    status: event.status,
    recipientHash: event.recipientHash,
    eventTime: event.eventTime,
    deliveryAttemptTime: event.deliveryAttemptTime,
  };
}

/** Durable dedupe and append-only audit are the SAME atomic insert, not best-effort logging. */
export function azureEmailEventStore(db: Db): AzureEventStore {
  return {
    async apply(events) {
      // Missing receipt is retryable: callback may beat the sender's durable receipt write.
      // Preflight the whole batch before effects; a mismatch never mutates any tenant.
      const matched: {
        event: AzureDeliveryAudit;
        receipt: string;
        recipient: string;
        teamId: string;
        mailbox?: { outboxId: string; attemptId: string; recipientHashes: string[] };
      }[] = [];
      for (const event of [...events].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.messageId)
        )
          throw new AzureEventConflict();
        const receipt = `smtp-relay:azure:${event.messageId.toLowerCase()}`;
        const [email] = await db
          .select()
          .from(schema.emails)
          .where(eq(schema.emails.sesMessageId, receipt));
        const boxes = await db
          .select()
          .from(schema.mailboxOutbox)
          .where(eq(schema.mailboxOutbox.providerMessageId, receipt))
          .limit(2);
        if (email && boxes.length) throw new AzureEventConflict();
        if (!email) {
          const box = boxes[0];
          if (boxes.length > 1) throw new AzureEventConflict();
          if (!box) throw new Error("azure_receipt_pending_or_unknown");
          if (
            box.status !== "accepted" ||
            !box.attemptId ||
            !box.recipientHashes ||
            !box.recipientHashes.includes(
              mailboxRecipientHashFromPublicHash(box.teamId, event.recipientHash),
            )
          )
            throw new AzureEventConflict();
          matched.push({
            event,
            receipt,
            recipient: "",
            teamId: box.teamId,
            mailbox: {
              outboxId: box.id,
              attemptId: box.attemptId,
              recipientHashes: [...box.recipientHashes],
            },
          });
          continue;
        }
        const recipient = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].find(
          (r) => hashRecipient(r) === event.recipientHash,
        );
        if (!recipient || !email.sentAt) throw new AzureEventConflict();
        matched.push({ event, receipt, recipient, teamId: email.teamId });
      }
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        for (const { event, receipt, recipient, teamId, mailbox } of matched) {
          const id = azureEventAuditId(event.eventId);
          const data = metadata(event);
          const [inserted] = await tx
            .insert(auditLog)
            .values({
              id,
              teamId,
              actorId: "system",
              action: "sending.azure_delivery_report",
              data,
            })
            .onConflictDoNothing({ target: auditLog.id })
            .returning({ id: auditLog.id });
          if (!inserted) {
            const [existing] = await tx.select().from(auditLog).where(eq(auditLog.id, id));
            if (
              !existing ||
              existing.teamId !== teamId ||
              existing.actorId !== "system" ||
              existing.action !== "sending.azure_delivery_report" ||
              !existing.data ||
              Object.keys(existing.data).length !== 7 ||
              Object.entries(data).some(([key, value]) => existing.data?.[key] !== value)
            )
              throw new AzureEventConflict();
            continue;
          }
          if (event.status === "expanded") continue;
          if (mailbox) {
            await acceptMailboxOutbox(tx, mailbox.outboxId, {
              attemptId: mailbox.attemptId,
              messageId: receipt,
              outboundEvidence: {
                azureResource: MAILBOX_AZURE_RESOURCE,
                azureEventId: event.eventId,
                outcome:
                  event.status === "delivered"
                    ? "delivered"
                    : event.status === "hard_bounce"
                      ? "hard_bounce"
                      : "rejected",
                recipientHashes: [mailboxRecipientHashFromPublicHash(teamId, event.recipientHash)],
                approvedRecipientHashes: mailbox.recipientHashes,
                occurredAt: new Date(event.deliveryAttemptTime),
              },
            });
            continue;
          }
          const kind =
            event.status === "delivered"
              ? "Delivery"
              : event.status === "hard_bounce"
                ? "Bounce"
                : "Reject";
          await processProviderEvent(
            tx,
            {
              eventType: kind,
              sesMessageId: receipt,
              occurredAt: event.deliveryAttemptTime,
              data: metadata(event),
              ...(kind === "Bounce"
                ? { bounce: { bounceType: "Permanent", recipients: [recipient] } }
                : {}),
            },
            {
              snsMessageId: `azure:${event.eventId}`,
              expectedRecipientHash: event.recipientHash,
              // Persist the existing webhook outbox; existing reconcile sweep drains it.
              enqueueWebhookDelivery: async () => {},
            },
          );
        }
      });
    },
    async append(teamId, events) {
      await db.transaction(async (tx) => {
        // Stable order prevents opposite-order batches from deadlocking their PK inserts.
        for (const event of [...events].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
          const id = azureEventAuditId(event.eventId);
          const data = metadata(event);
          const inserted = await tx
            .insert(auditLog)
            .values({ id, teamId, actorId: "system", action: AZURE_EVENT_AUDIT_ACTION, data })
            .onConflictDoNothing({ target: auditLog.id })
            .returning({ id: auditLog.id });
          if (inserted.length) continue;
          // READ COMMITTED: after a concurrent insert commits, compare immutable facts.
          const [existing] = await tx.select().from(auditLog).where(eq(auditLog.id, id));
          if (
            !existing ||
            existing.teamId !== teamId ||
            existing.action !== AZURE_EVENT_AUDIT_ACTION ||
            existing.actorId !== "system" ||
            existing.data === null ||
            Object.keys(existing.data).length !== Object.keys(data).length ||
            Object.entries(data).some(([key, value]) => existing.data?.[key] !== value)
          ) {
            throw new AzureEventConflict();
          }
        }
      });
    },
  };
}
