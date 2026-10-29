import { createHash } from "node:crypto";
import type { Db } from "@millionsend/db";
import { auditLog } from "@millionsend/db/schema";
import { eq } from "drizzle-orm";
import {
  AZURE_EMAIL_SOURCE,
  type AzureDeliveryAudit,
  AzureEventConflict,
  type AzureEventStore,
} from "./azure-email-events";

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
