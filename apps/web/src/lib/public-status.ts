export const STATUS_CHECK_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 3_000;

/** Public HTTP availability only: no credentials, account data or delivery claims. */
export const PUBLIC_STATUS_TARGETS = [
  { id: "web", url: "https://mepmail.dev/api/version" },
  { id: "api", url: "https://api.mepmail.dev/health" },
  { id: "docs", url: "https://docs.mepmail.dev" },
] as const;

export type PublicStatusId = (typeof PUBLIC_STATUS_TARGETS)[number]["id"];
export interface PublicStatusSnapshot {
  checkedAt: string;
  checks: { id: PublicStatusId; available: boolean; httpStatus: number | null }[];
}

/** Bounded, shared reads; viewing the page never starts a polling timer. */
export function createPublicStatusReader(
  request: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  let snapshot: PublicStatusSnapshot | undefined;
  let expiresAt = 0;
  let pending: Promise<PublicStatusSnapshot> | undefined;
  return async (): Promise<PublicStatusSnapshot> => {
    if (snapshot && now() < expiresAt) return snapshot;
    if (pending) return pending;
    pending = (async () => {
      const checks = await Promise.all(
        PUBLIC_STATUS_TARGETS.map(async ({ id, url }) => {
          try {
            const response = await request(url, {
              method: "GET",
              credentials: "omit",
              redirect: "error",
              cache: "no-store",
              signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
            });
            // Bodies may contain documentation HTML; none is read or returned.
            await response.body?.cancel();
            return { id, available: response.ok, httpStatus: response.status };
          } catch {
            return { id, available: false, httpStatus: null };
          }
        }),
      );
      snapshot = { checkedAt: new Date(now()).toISOString(), checks };
      expiresAt = now() + STATUS_CHECK_TTL_MS;
      return snapshot;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}

export const readPublicStatus = createPublicStatusReader();
