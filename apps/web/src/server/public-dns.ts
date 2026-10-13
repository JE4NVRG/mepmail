import { Resolver, resolveMx as serverResolveMx } from "node:dns/promises";
import type { MailboxMxAnswer } from "@millionsend/core";

/**
 * Public resolvers asked directly: an answer cached inside the container or on the host
 * (an old provider's MX right after a migration) must not stand in for today's DNS.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
export const PUBLIC_DNS_SOURCE = "public DNS (1.1.1.1, 8.8.8.8)";
export const SERVER_DNS_SOURCE = "server resolver (may be cached)";

/** No MX at all is an answer, not an outage. */
function noRecords(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}

/** The MX of `name` from public DNS, or the server's resolver (said so) when they are unreachable. */
export async function resolveMxPublic(name: string): Promise<MailboxMxAnswer> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(PUBLIC_RESOLVERS);
  try {
    return { records: await resolver.resolveMx(name), source: PUBLIC_DNS_SOURCE };
  } catch (error) {
    if (noRecords(error)) return { records: [], source: PUBLIC_DNS_SOURCE };
    return { records: await serverResolveMx(name), source: SERVER_DNS_SOURCE };
  }
}

/** The records only, for callers that do not report the source. */
export async function resolveMxRecords(name: string) {
  return (await resolveMxPublic(name)).records;
}
