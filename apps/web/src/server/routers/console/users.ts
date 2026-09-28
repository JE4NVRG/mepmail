import { findInstanceOperator } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, asc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { escapeLike } from "@/lib/sql";
import { operatorProcedure, router } from "../../trpc";

const SORT_KEYS = ["name", "email", "teams", "sent30d", "joined", "seen"] as const;

const u = schema.user;
const m = schema.teamMembers;

/**
 * The aggregates every row carries, each a correlated subquery on the user
 * id — index ranges only, the same shape the teams list uses. A user with no
 * team reads zeros, never null.
 */
const teamsCount = sql<number>`(select count(*)::int from ${m} m where m.user_id = ${u}."id")`;
const ownsCount = sql<number>`(select count(*)::int from ${m} m where m.user_id = ${u}."id" and m.role = 'owner')`;
const teamNames = sql<
  string[]
>`(select coalesce(array_agg(t.name order by t.name), '{}') from ${m} m join ${schema.teams} t on t.id = m.team_id where m.user_id = ${u}."id")`;
/** The 30-day sends of every team they belong to; a shared team counts for each of its members. */
const sent30d = sql<number>`(select coalesce(sum(st.sent_30d), 0)::int from ${m} m join ${schema.teamStandings} st on st.team_id = m.team_id where m.user_id = ${u}."id")`;
/**
 * The newest session row: when they last signed in, not what they did after.
 * Read as ISO text because a raw expression carries no column codec — the
 * driver's own timestamp parsing would differ between Postgres and the test
 * database — and mapped to a Date in the row below.
 */
const lastSeenAt = sql<
  string | null
>`(select to_char(max(s.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from ${schema.session} s where s.user_id = ${u}."id")`;

const ROW = {
  id: u.id,
  name: u.name,
  email: u.email,
  emailVerified: u.emailVerified,
  createdAt: u.createdAt,
  teams: teamsCount,
  ownsTeams: ownsCount,
  teamNames,
  sent30d,
  lastSeenAt,
};

const SORT_EXPR: Record<(typeof SORT_KEYS)[number], SQL | AnyPgColumn> = {
  name: u.name,
  email: u.email,
  teams: teamsCount,
  sent30d,
  joined: u.createdAt,
  seen: lastSeenAt,
};

/** Anything an operator has in hand: a name, an e-mail, the id from an audit row or a Stripe webhook. */
function searchWhere(q: string): SQL | undefined {
  const like = `%${escapeLike(q)}%`;
  return or(ilike(u.name, like), ilike(u.email, like), eq(u.id, q));
}

/**
 * The people on this instance: who they are, which and how many teams they
 * belong to, what those teams sent in the last 30 days, when they joined and
 * when they last signed in. Read-only, no secret column anywhere — the
 * operator already sees each of these facts one team at a time; this is the
 * instance-wide view of them.
 */
export const consoleUsersRouter = router({
  list: operatorProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        verified: z.enum(["yes", "no"]).optional(),
        sort: z.enum(SORT_KEYS).default("joined"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: (SQL | undefined)[] = [];
      if (input.search) filters.push(searchWhere(input.search));
      if (input.verified) filters.push(eq(u.emailVerified, input.verified === "yes"));
      const where = filters.length > 0 ? and(...filters) : undefined;
      const expr = SORT_EXPR[input.sort];
      const order =
        input.dir === "asc" ? sql`${expr} asc nulls last` : sql`${expr} desc nulls last`;
      const [rows, [count], operator] = await Promise.all([
        ctx.db
          .select(ROW)
          .from(u)
          .where(where)
          .orderBy(order, asc(u.id))
          .limit(input.limit + 1)
          .offset(input.offset),
        ctx.db
          .select({
            total: sql<number>`count(*)::int`,
            verified: sql<number>`count(*) filter (where ${u.emailVerified})::int`,
          })
          .from(u)
          .where(where),
        findInstanceOperator(ctx.db),
      ]);
      const items = rows.slice(0, input.limit);
      return {
        items: items.map(({ lastSeenAt: seen, ...row }) => ({
          ...row,
          lastSeenAt: seen ? new Date(seen) : null,
          isOperator: row.id === operator?.id,
        })),
        total: count?.total ?? 0,
        verified: count?.verified ?? 0,
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
        operatorId: operator?.id ?? null,
      };
    }),
});
