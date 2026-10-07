import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Links every OAuth client already allowed to request `from` to `to` as well.
 *
 * The authorization server only lets a client request the resources linked to
 * it (RFC 8707 per-client validation), and dynamic registration links new
 * clients to the defaults of the day. When the MCP server gains a second host
 * (an advertised brand domain), clients registered before it are linked to
 * the canonical identifier only; this gives each of them the new one too, so
 * an agent that switches to the new URL keeps its registration. Idempotent:
 * clients that already have `to` are skipped. Returns how many links it added.
 */
export async function linkClientsToResource(db: Db, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const link = schema.oauthClientResource;
  const [target] = await db
    .select({ identifier: schema.oauthResource.identifier })
    .from(schema.oauthResource)
    .where(eq(schema.oauthResource.identifier, to));
  if (!target) throw new Error(`OAuth resource ${to} is not seeded yet`);
  const linked = await db
    .select({ clientId: link.clientId })
    .from(link)
    .where(eq(link.resourceId, from));
  if (linked.length === 0) return 0;
  const ids = linked.map((row) => row.clientId);
  const already = new Set(
    (
      await db
        .select({ clientId: link.clientId })
        .from(link)
        .where(and(eq(link.resourceId, to), inArray(link.clientId, ids)))
    ).map((row) => row.clientId),
  );
  const missing = [...new Set(ids)].filter((clientId) => !already.has(clientId));
  if (missing.length === 0) return 0;
  const now = new Date();
  await db
    .insert(link)
    .values(
      missing.map((clientId) => ({ id: randomUUID(), clientId, resourceId: to, createdAt: now })),
    );
  return missing.length;
}
