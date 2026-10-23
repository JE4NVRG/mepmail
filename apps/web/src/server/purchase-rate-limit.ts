import { createHash } from "node:crypto";
import { env } from "@millionsend/config";
import { resultRows } from "@millionsend/core";
import { TRPCError } from "@trpc/server";
import { type SQL, sql } from "drizzle-orm";
import { headers } from "next/headers";

/**
 * A team starting eight purchases in an hour is not a customer having a bad
 * day; it is a script. Stripe Radar judges each card and blocks most of them,
 * but only after our endpoint has already minted the session and the customer
 * record. This counter stops the churn in front of Radar.
 */
const TEAM_LIMIT_PER_HOUR = 8;

/**
 * Higher than the team limit because one address can legitimately cover an
 * office, a shared connection or a carrier NAT with several separate teams.
 */
const IP_LIMIT_PER_HOUR = 30;

type Db = { execute: (query: SQL) => Promise<unknown> };

/** Thrown inside the guarded block so the outer catch can tell it apart. */
class RateLimited extends Error {}

async function bump(db: Db, bucket: string): Promise<number> {
  const rows = resultRows<{ count: number }>(
    await db.execute(sql`
      insert into purchase_rate_limits (bucket, window_start, count)
      values (${bucket}, date_trunc('hour', now()), 1)
      on conflict (bucket) do update set
        count = case
          when purchase_rate_limits.window_start = excluded.window_start
            then purchase_rate_limits.count + 1
          else 1
        end,
        window_start = excluded.window_start
      returning count
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * First hop of `x-forwarded-for` is the client as our own Nginx saw it; the
 * proxy overwrites the header, so a caller cannot pick its own bucket. A
 * value that is missing or absurdly long is ignored rather than trusted.
 */
function requestIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  const raw = forwarded ? forwarded.split(",")[0]?.trim() : headerList.get("x-real-ip")?.trim();
  if (!raw || raw.length > 64) return null;
  return raw;
}

function ipBucket(ip: string): string {
  const digest = createHash("sha256")
    .update(`${ip}:${env.BETTER_AUTH_SECRET ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `ip:${digest}`;
}

/**
 * Refuses a billing mutation once the team, or the address behind it, has
 * started too many purchases inside the current hour.
 *
 * Fail-open on purpose: if the counter is unavailable (database error, table
 * not migrated yet) the purchase continues, because Radar is still judging the
 * card and a broken counter must never stop a real customer from paying.
 */
export async function enforcePurchaseRateLimit(db: Db, teamId: string): Promise<void> {
  try {
    if ((await bump(db, `team:${teamId}`)) > TEAM_LIMIT_PER_HOUR) throw new RateLimited();
    let ip: string | null = null;
    try {
      ip = requestIp(await headers());
    } catch {
      // Outside a request scope there is no address to bucket; the team
      // counter above already applied.
      ip = null;
    }
    if (ip && (await bump(db, ipBucket(ip))) > IP_LIMIT_PER_HOUR) throw new RateLimited();
  } catch (error) {
    if (error instanceof RateLimited) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "PURCHASE_RATE_LIMITED",
      });
    }
    console.error("billing: purchase rate limit unavailable", error);
  }
}
