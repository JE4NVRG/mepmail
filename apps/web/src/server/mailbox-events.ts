import { env } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import { and, eq, or, sql } from "drizzle-orm";
import { listenToChannel } from "../../../../packages/db/src/listen";

/**
 * Live updates for open Correio windows. Migration 0028 announces each message
 * received now on the "mailbox_arrivals" channel; this process keeps one
 * LISTEN connection and hands every arrival to the event streams it serves
 * (app/api/mailboxes/events). Only identifiers travel: team and mailbox.
 */
export type MailboxArrival = { teamId: string; mailboxId: string };
type Listener = (arrival: MailboxArrival) => void;

const CHANNEL = "mailbox_arrivals";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The payload the trigger sends, or null when it is not one. */
export function parseMailboxArrival(payload: string): MailboxArrival | null {
  try {
    const value = JSON.parse(payload) as { t?: unknown; m?: unknown };
    return typeof value.t === "string" &&
      typeof value.m === "string" &&
      UUID.test(value.t) &&
      UUID.test(value.m)
      ? { teamId: value.t, mailboxId: value.m }
      : null;
  } catch {
    return null;
  }
}

// One hub per process, kept across hot reloads in development.
type Hub = { listeners: Set<Listener>; started: Promise<void> | null };
const globalHub = globalThis as unknown as { __mailboxArrivals?: Hub };
if (!globalHub.__mailboxArrivals)
  globalHub.__mailboxArrivals = { listeners: new Set(), started: null };
const hub: Hub = globalHub.__mailboxArrivals;

function start(): Promise<void> {
  if (!hub.started) {
    // Its own connection: LISTEN holds a session for the life of the process.
    hub.started = listenToChannel(env.DATABASE_URL, CHANNEL, (payload) => {
      const arrival = parseMailboxArrival(payload);
      if (!arrival) return;
      for (const listener of hub.listeners) listener(arrival);
    }).then(
      () => undefined,
      (error: unknown) => {
        hub.started = null;
        throw error;
      },
    );
  }
  return hub.started;
}

/** Calls `listener` for every arrival until the returned function is called. */
export async function subscribeMailboxArrivals(listener: Listener): Promise<() => void> {
  await start();
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
  };
}

/** The mailboxes this person reads: their own, and those shared with them and not revoked. */
export async function readableMailboxIds(
  db: Db,
  actor: { teamId: string; userId: string },
): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.mailboxes.id })
    .from(schema.mailboxes)
    .where(
      and(
        eq(schema.mailboxes.teamId, actor.teamId),
        eq(schema.mailboxes.status, "planned"),
        or(
          eq(schema.mailboxes.ownerUserId, actor.userId),
          sql`exists (select 1 from ${schema.mailboxGrants} g where g.mailbox_id = ${schema.mailboxes.id} and g.team_id = ${actor.teamId} and g.user_id = ${actor.userId} and g.revoked_at is null)`,
        ),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** One server-sent event: the mailbox that just received mail. */
export function arrivalEvent(mailboxId: string): string {
  return `event: arrival\ndata: ${JSON.stringify({ mailboxId })}\n\n`;
}
