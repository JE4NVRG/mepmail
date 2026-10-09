import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { env } from "@millionsend/config";
import { getDb, schema } from "@millionsend/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { httpOrigin } from "@/lib/http-url";
import { getAuth, OAUTH_SCOPES } from "@/server/auth";
import { mailboxRegistryEnabled } from "@/server/mailboxes";
import { ACTIVE_TEAM_COOKIE, getActiveMembership, listMemberships } from "@/server/membership";
import { ConsentForm } from "./consent-form";

/**
 * OAuth consent screen. The provider redirects here with a signed copy of
 * the authorization query (client_id, scope, sig, exp…); the form posts it
 * back through the auth client, which is what completes the flow.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    }
  }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || !(await verifyOAuthQueryParams(query.toString(), secret))) notFound();
  const session = await getAuth().api.getSession({ headers: await headers() });
  // Expired session: the login resumes the pending authorization from the
  // same signed query, exactly as the provider's own login redirect does.
  if (!session) redirect(`/login?${query}`);

  const db = getDb();
  const clientId = query.get("client_id");
  const [client] = clientId
    ? await db
        .select({
          clientId: schema.oauthClient.clientId,
          name: schema.oauthClient.name,
          uri: schema.oauthClient.uri,
          redirectUris: schema.oauthClient.redirectUris,
          createdAt: schema.oauthClient.createdAt,
          skipConsent: schema.oauthClient.skipConsent,
        })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
    : [];
  const teams = await listMemberships(db, session.user.id);
  const active = await getActiveMembership(
    db,
    session.user.id,
    (await cookies()).get(ACTIVE_TEAM_COOKIE)?.value,
  );
  // Mail scopes act only in mailboxes the person owns and ticks here, per team.
  const mailboxes: Record<string, { id: string; address: string; label: string }[]> = {};
  if (mailboxRegistryEnabled() && teams.length) {
    try {
      const rows = await db
        .select({
          id: schema.mailboxes.id,
          teamId: schema.mailboxes.teamId,
          address: schema.mailboxes.address,
          label: schema.mailboxes.label,
        })
        .from(schema.mailboxes)
        .where(
          and(
            eq(schema.mailboxes.ownerUserId, session.user.id),
            eq(schema.mailboxes.status, "planned"),
            inArray(
              schema.mailboxes.teamId,
              teams.map((team) => team.teamId),
            ),
          ),
        )
        .orderBy(asc(schema.mailboxes.address))
        .limit(200);
      for (const row of rows) {
        const list = mailboxes[row.teamId] ?? [];
        list.push(row);
        mailboxes[row.teamId] = list;
      }
    } catch (error) {
      console.warn("consent: mailbox list unavailable", error);
    }
  }
  // Only known scopes are described; the provider rejects unknown ones anyway.
  const scopes = (query.get("scope") ?? "")
    .split(" ")
    .filter((scope) => (OAUTH_SCOPES as string[]).includes(scope));

  return (
    <ConsentForm
      app={
        client
          ? {
              clientId: client.clientId,
              name: client.name,
              uri: client.uri,
              // Where the code (and the user) end up after Allow — the one
              // fact about the app the registrant could not make up.
              redirectOrigins: [
                ...new Set(client.redirectUris.map(httpOrigin).filter((o) => o !== null)),
              ],
              // Only operator-trusted clients skip consent; everything else
              // self-registered and is shown as such.
              unverified: !client.skipConsent,
              registeredAt: client.createdAt?.toISOString() ?? null,
            }
          : null
      }
      userEmail={session.user.email}
      scopes={scopes}
      teams={teams.map(({ teamId, teamName, role }) => ({ teamId, teamName, role }))}
      defaultTeamId={active?.teamId ?? null}
      mailboxes={mailboxes}
    />
  );
}
