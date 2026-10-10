import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import { advertisingCookie, type ConsentProof } from "./advertising-consent.js";
import {
  buildGoogleSignUp,
  type GoogleConversionConfig,
  type GoogleFetch,
  googleClientId,
  googleConversionConfigured,
  googleSessionId,
  sendGooglePurchase,
} from "./google-advertising.js";
import { accepted, proofMatches, receiptFor } from "./meta-advertising.js";
import {
  buildMetaConversionPayload,
  type MetaConversionConfig,
  type MetaConversionTransport,
  metaConversionConfigured,
  sendMetaConversion,
} from "./meta-conversions.js";

const outbox = schema.signupConversionOutbox;
type Outbox = typeof outbox.$inferSelect;
/** Meta takes events up to 7 days old; the signal is only useful while the click is fresh. */
const META_DELIVERY_MS = 24 * 60 * 60 * 1000;
/** The Measurement Protocol accepts events up to 72 hours old. */
const GOOGLE_DELIVERY_MS = 72 * 60 * 60 * 1000;

export interface SignupAdvertising {
  meta?: MetaConversionConfig | undefined;
  google?: GoogleConversionConfig | undefined;
  proof: ConsentProof | null;
  cookieHeader: string | null;
}

/**
 * At account creation, in the request that created it: a finished sign-up for
 * each configured vendor, only when this browser carries an accepted, current
 * advertising consent that is not someone else's. The consent becomes this
 * person's. Nothing is captured without a browser identifier, and nothing is
 * ever backfilled later. Returns the vendors queued.
 */
export async function recordSignupConversions(
  db: Db,
  userId: string,
  advertising: SignupAdvertising,
  now = new Date(),
): Promise<("meta" | "google")[]> {
  const meta = advertising.meta && metaConversionConfigured(advertising.meta);
  const google = googleConversionConfigured(advertising.google);
  if ((!meta && !google) || !advertising.proof || !userId) return [];
  const proof = advertising.proof;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Consent lock first everywhere: a withdrawal cannot race this capture.
    const receipt = await receiptFor(tx, proof.id, true);
    if (
      !proofMatches(receipt, proof, now) ||
      !accepted(receipt, now) ||
      (receipt.userId && receipt.userId !== userId)
    )
      return [];
    const queued: ("meta" | "google")[] = [];
    const fbp = meta ? advertisingCookie(advertising.cookieHeader, "_fbp") : null;
    const fbc = meta ? advertisingCookie(advertising.cookieHeader, "_fbc") : null;
    if (
      meta &&
      receipt.sourceUrl &&
      buildMetaConversionPayload({
        eventName: "CompleteRegistration",
        eventId: randomUUID(),
        eventTime: Math.floor(now.getTime() / 1000),
        eventSourceUrl: receipt.sourceUrl,
        consent: "granted",
        matching: { ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}) },
      }).status === "built"
    ) {
      const rows = await tx
        .insert(outbox)
        .values({
          userId,
          vendor: "meta",
          consentReceiptId: receipt.id,
          sourceUrl: receipt.sourceUrl,
          fbp,
          fbc,
          eventTime: now,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + META_DELIVERY_MS),
        })
        .onConflictDoNothing()
        .returning({ id: outbox.id });
      if (rows.length) queued.push("meta");
    }
    const clientId = google ? googleClientId(advertising.cookieHeader) : null;
    if (google && clientId && advertising.google) {
      const rows = await tx
        .insert(outbox)
        .values({
          userId,
          vendor: "google",
          consentReceiptId: receipt.id,
          clientId,
          sessionId: googleSessionId(advertising.cookieHeader, advertising.google.measurementId!),
          eventTime: now,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + GOOGLE_DELIVERY_MS),
        })
        .onConflictDoNothing()
        .returning({ id: outbox.id });
      if (rows.length) queued.push("google");
    }
    if (queued.length && !receipt.userId)
      await tx
        .update(schema.advertisingConsentReceipts)
        .set({ userId, updatedAt: now })
        .where(eq(schema.advertisingConsentReceipts.id, receipt.id));
    return queued;
  });
}

/**
 * Worker side: each due row, re-checking under the consent lock that the
 * consent is still accepted and still this person's before the one POST.
 */
export async function dispatchSignupConversions(
  db: Db,
  config: { meta?: MetaConversionConfig | undefined; google?: GoogleConversionConfig | undefined },
  deps: { metaTransport?: MetaConversionTransport; googleFetch?: GoogleFetch; now?: () => Date },
): Promise<{ considered: number; sent: number }> {
  const meta = config.meta && metaConversionConfigured(config.meta) && deps.metaTransport;
  const google =
    config.google && googleConversionConfigured(config.google) && deps.googleFetch
      ? config.google
      : null;
  const vendors = [...(meta ? ["meta" as const] : []), ...(google ? ["google" as const] : [])];
  if (!vendors.length) return { considered: 0, sent: 0 };
  const clock = deps.now ?? (() => new Date());
  const due = await db
    .select()
    .from(outbox)
    .where(
      and(
        inArray(outbox.vendor, vendors),
        lte(outbox.nextAttemptAt, clock()),
        or(
          eq(outbox.status, "pending"),
          and(eq(outbox.status, "leased"), lte(outbox.leaseUntil, clock())),
        ),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const candidate of due) {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const receipt = await receiptFor(tx, candidate.consentReceiptId, true);
      const [row] = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.id, candidate.id))
        .for("update", { skipLocked: true });
      const now = clock();
      if (
        !row ||
        !["pending", "leased"].includes(row.status) ||
        row.nextAttemptAt > now ||
        (row.status === "leased" && row.leaseUntil && row.leaseUntil > now)
      )
        return;
      const finish = (
        status: Outbox["status"],
        lastFailure: string | null,
        extra: Partial<Outbox> = {},
      ) =>
        tx
          .update(outbox)
          .set({ status, lastFailure, leaseUntil: null, ...extra })
          .where(eq(outbox.id, row.id));
      const erased = { fbp: null, fbc: null, clientId: null, sessionId: null };
      if (!accepted(receipt, now) || receipt.userId !== row.userId) {
        await finish("cancelled", "consent_withdrawn", erased);
        return;
      }
      if (row.expiresAt <= now || row.attempts >= 5) {
        await finish("dead", "delivery_expired", erased);
        return;
      }
      await tx
        .update(outbox)
        .set({ status: "leased", leaseUntil: new Date(now.getTime() + 120_000) })
        .where(eq(outbox.id, row.id));
      let outcome: { status: "accepted" } | { status: "retry" | "dead"; reason: string };
      if (row.vendor === "meta" && meta && config.meta) {
        const result = await sendMetaConversion(
          {
            eventName: "CompleteRegistration",
            eventId: row.eventId,
            eventTime: Math.floor(row.eventTime.getTime() / 1000),
            eventSourceUrl: row.sourceUrl ?? "",
            consent: "granted",
            matching: {
              ...(row.fbp ? { fbp: row.fbp } : {}),
              ...(row.fbc ? { fbc: row.fbc } : {}),
            },
          },
          config.meta,
          meta,
        );
        outcome =
          result.status === "accepted"
            ? { status: "accepted" }
            : result.status === "retry"
              ? { status: "retry", reason: result.reason }
              : { status: "dead", reason: result.reason };
      } else if (row.vendor === "google" && google && deps.googleFetch && row.clientId) {
        const result = await sendGooglePurchase(
          buildGoogleSignUp({
            clientId: row.clientId,
            sessionId: row.sessionId,
            eventTime: row.eventTime,
          }),
          google as Required<GoogleConversionConfig>,
          deps.googleFetch,
        );
        outcome =
          result.status === "accepted"
            ? { status: "accepted" }
            : result.status === "retry"
              ? { status: "retry", reason: result.reason }
              : { status: "dead", reason: result.reason };
      } else {
        outcome = { status: "dead", reason: "configuration" };
      }
      if (outcome.status === "accepted") {
        // Delivered: the browser ids have served their one purpose.
        await finish("sent", null, { attempts: row.attempts + 1, ...erased });
        sent++;
      } else if (outcome.status === "retry")
        await finish("pending", outcome.reason, {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 60_000 * 2 ** row.attempts)),
        });
      else await finish("dead", outcome.reason, { attempts: row.attempts + 1, ...erased });
    });
  }
  return { considered: due.length, sent };
}
