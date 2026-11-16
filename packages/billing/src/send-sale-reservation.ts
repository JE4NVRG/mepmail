import { randomUUID } from "node:crypto";
import type { PlanRungKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { assertPurchaseEligibility } from "./purchase-eligibility.js";
import {
  assertSendSaleCapacity,
  assertSendSaleObservationFresh,
  captureSendSaleCapacity,
  SendSaleCapacityError,
  type SendSaleCapacitySource,
} from "./send-sale-capacity.js";

/** A retained, differently scoped purchase is a conflict, not a fresh capacity quote. */
export class SendSaleIntentConflict extends SendSaleCapacityError {
  constructor() {
    super("capacity_insufficient");
    this.name = "SendSaleIntentConflict";
  }
}
export const SALE_POOL_LOCK = "mepmail:send-commercial-capacity:v1";
export type SaleReservation = {
  id: string;
  kind: "card" | "pix" | "upgrade";
  rung: PlanRungKey;
  subscriptionId: string | null;
};
export function lockSendSalePool(tx: Db): Promise<unknown> {
  return tx.execute(
    sql`select pg_advisory_xact_lock(18475923,49), pg_advisory_xact_lock(hashtext(${SALE_POOL_LOCK})), pg_advisory_xact_lock(18475923,48)`,
  );
}
function rows<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
}

/** Root transaction commits the durable promise before ANY provider POST. No upstream calls here. */
export async function reserveSendSaleCapacity(
  db: Db,
  input: {
    teamId: string;
    userId: string;
    rung: PlanRungKey;
    kind: SaleReservation["kind"];
    subscriptionId?: string;
  },
  source?: SendSaleCapacitySource,
): Promise<SaleReservation> {
  const observation = await captureSendSaleCapacity(source);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Pool always precedes customer/team/member locks. Lifecycle release never acquires the pool.
    await lockSendSalePool(tx);
    const [team] = await tx
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("share");
    const [member] = await tx
      .select()
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, input.teamId),
          eq(schema.teamMembers.userId, input.userId),
        ),
      )
      .for("share");
    if (!team || team.plan === "system" || !member || !["owner", "admin"].includes(member.role))
      throw new SendSaleCapacityError("capacity_unknown");
    if (input.kind === "upgrade" && team.stripeSubscriptionId !== input.subscriptionId)
      throw new SendSaleCapacityError("capacity_unknown");
    await assertPurchaseEligibility(tx, input.teamId);
    const active = rows<{ id: string; data: SaleReservation }>(
      await tx.execute(sql`
      select id::text, data from ${schema.auditLog} h
      where h.team_id=${input.teamId} and h.action='sending.sale_reserved'
        and not exists(select 1 from ${schema.auditLog} r where r.action='sending.sale_released' and r.team_id=h.team_id and r.target=h.target)
      order by h.created_at desc limit 1`),
    )[0];
    if (active) {
      if (
        active.data.kind !== input.kind ||
        active.data.rung !== input.rung ||
        active.data.subscriptionId !== (input.subscriptionId ?? null)
      )
        throw new SendSaleIntentConflict();
      await assertSendSaleObservationFresh(tx, observation);
      return active.data;
    }
    await assertSendSaleCapacity(tx, input.teamId, input.rung, observation);
    const prior =
      input.kind === "card"
        ? await tx
            .select()
            .from(schema.sendCheckoutAttempts)
            .where(
              and(
                eq(schema.sendCheckoutAttempts.teamId, input.teamId),
                sql`${schema.sendCheckoutAttempts.status} <> 'resolved'`,
              ),
            )
        : [];
    if (prior.some((p) => p.rung !== input.rung))
      throw new SendSaleCapacityError("capacity_insufficient");
    const reservation: SaleReservation = {
      id: prior[0]?.id ?? randomUUID(),
      kind: input.kind,
      rung: input.rung,
      subscriptionId: input.subscriptionId ?? null,
    };
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: input.userId,
      action: "sending.sale_reserved",
      target: reservation.id,
      data: reservation,
      createdAt: sql`clock_timestamp()`,
    });
    await assertSendSaleObservationFresh(tx, observation);
    return reservation;
  });
}

/** Call only after an exact provider identity confirms terminal failure or after its contract is persisted.
 * Append-only: concurrent readers may conservatively count an old hold, never miss a new one.
 */
export async function releaseSendSaleCapacity(
  tx: Db,
  teamId: string,
  id: string,
  reason: "expired" | "contract" | "refunded",
): Promise<void> {
  await tx.execute(sql`insert into ${schema.auditLog} (team_id,action,target,data,created_at)
    select h.team_id,'sending.sale_released',h.target,jsonb_build_object('reason',${reason}::text),clock_timestamp()
    from ${schema.auditLog} h where h.action='sending.sale_reserved' and h.team_id=${teamId} and h.target=${id}
    and not exists(select 1 from ${schema.auditLog} r where r.action='sending.sale_released' and r.team_id=h.team_id and r.target=h.target)`);
}
