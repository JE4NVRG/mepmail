import type { QueryClient, QueryKey } from "@tanstack/react-query";

export type RecoveryPhase = "loading" | "refreshing" | "paused" | "error";
export type RecoverableQuery = {
  data?: unknown;
  error?: unknown;
  isPending?: boolean;
  isError?: boolean;
  isFetching?: boolean;
  fetchStatus?: string;
};

/** Cached content remains useful during a network failure, never after an access refusal. */
export function queryHasUsableData(query: RecoverableQuery): boolean {
  const error = query.error as { data?: { code?: string } } | null | undefined;
  const refused = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(error?.data?.code ?? "");
  return query.data !== undefined && query.data !== null && !refused;
}

export function queryRecoveryPhase(query: RecoverableQuery): RecoveryPhase | null {
  if (query.fetchStatus === "paused") return "paused";
  if (query.isError) return "error";
  if (query.isPending) return "loading";
  if (query.isFetching) return "refreshing";
  return null;
}

/**
 * Refetch alone can reuse the initial pending promise. Cancel this exact read first so a
 * stalled request can be retried, without cancelling other mailboxes or widening its scope.
 * Query's normal online/access policy still applies to the new request.
 */
export async function recoverQuery(
  client: Pick<QueryClient, "cancelQueries">,
  key: QueryKey,
  retry: () => Promise<unknown>,
  current: () => boolean = () => true,
): Promise<void> {
  if (!current()) return;
  await client.cancelQueries({ queryKey: key, exact: true });
  if (current()) await retry();
}
