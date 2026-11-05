import { queryHasUsableData, type RecoverableQuery } from "./query-recovery";
import { trpcErrorCode } from "./trpc-error";

// Retrying a read is safe; repeating a send or a mailbox mutation is not.
const TRANSIENT_READ_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "TIMEOUT",
]);

/** Two short retries recover a transient read without retrying access refusals. */
export function retryMailboxRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  const cause = error as { name?: string; cause?: { name?: string } } | null;
  if (cause?.name === "AbortError" || cause?.cause?.name === "AbortError") return false;
  const code = trpcErrorCode(error);
  if (code) return TRANSIENT_READ_CODES.has(code);
  // A browser/network failure has no tRPC error code. Never interpret it as permission.
  return error instanceof Error;
}

/** A reader never revives old private content after any failed read, even after an earlier refusal. */
export function mailboxReaderHasUsableData(query: RecoverableQuery): boolean {
  return !query.isError && queryHasUsableData(query);
}

/** Whether a failure means access was refused rather than a connection problem. */
export function mailboxReadAccessRefused(error: unknown): boolean {
  return ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(trpcErrorCode(error) ?? "");
}

export function mailboxReadRetryDelay(attempt: number): number {
  return attempt === 0 ? 250 : 750;
}

/** Only use on queries/prefetches. Mutation retries deliberately remain disabled. */
export const MAILBOX_READ_QUERY_OPTIONS = {
  retry: retryMailboxRead,
  retryDelay: mailboxReadRetryDelay,
};
