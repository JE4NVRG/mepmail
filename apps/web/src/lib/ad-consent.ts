// Mirrors ADVERTISING_POLICY_VERSION in @millionsend/billing.
export const AD_POLICY_VERSION = "ads-v2" as const;
export type AdConsentState = "unknown" | "accepted" | "denied";
export interface AdConsentSnapshot {
  state: AdConsentState;
  pending: boolean;
  error: boolean;
}
const INITIAL: AdConsentSnapshot = { state: "unknown", pending: false, error: false };
const READ_FRESHNESS_MS = 30_000;
const READ_ERROR_BACKOFF_MS = 5_000;

/** Server cookie proof is authoritative. No local storage receipt or identifier. */
export function createAdConsentStore(request: typeof fetch, now = () => Date.now()) {
  let snapshot = INITIAL;
  let revision = 0;
  let blockedLocally = false;
  let reading: Promise<void> | undefined;
  let readAfter = 0;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: AdConsentSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const responseState = async (response: Response): Promise<AdConsentState> => {
    if (!response.ok) throw new Error("consent_unavailable");
    const body = await response.json();
    if (
      body.policyVersion !== AD_POLICY_VERSION ||
      !["unknown", "accepted", "denied"].includes(body.state)
    )
      throw new Error("consent_invalid");
    return body.state;
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read(options: { force?: boolean } = {}): Promise<void> {
      if (snapshot.pending) return writes;
      if (reading) return reading;
      // Repeated visibility/route events reuse this document's recent server
      // answer. Explicit settings/retry actions can recheck immediately.
      if (!options.force && now() < readAfter) return Promise.resolve();
      const current = revision;
      reading = (async () => {
        try {
          const state = await responseState(
            await request("/api/advertising-consent", {
              credentials: "same-origin",
              cache: "no-store",
            }),
          );
          if (current === revision) {
            readAfter = now() + READ_FRESHNESS_MS;
            publish(
              blockedLocally && state === "accepted"
                ? { state: "denied", pending: false, error: true }
                : { state, pending: false, error: false },
            );
          }
        } catch {
          if (current === revision) {
            readAfter = now() + READ_ERROR_BACKOFF_MS;
            publish({ state: "unknown", pending: false, error: true });
          }
        } finally {
          reading = undefined;
        }
      })();
      return reading;
    },
    blockLocally() {
      ++revision;
      readAfter = 0;
      blockedLocally = true;
      publish({ state: "denied", pending: false, error: true });
    },
    choose(granted: boolean): Promise<void> {
      const current = ++revision;
      readAfter = 0;
      blockedLocally = true;
      // Revoke synchronously, including while an earlier accept is still in flight.
      publish({ state: granted ? "unknown" : "denied", pending: true, error: false });
      const operation = writes.then(async () => {
        try {
          const state = await responseState(
            await request("/api/advertising-consent", {
              method: "POST",
              // The site sends Referrer-Policy: no-referrer; the receipt's source page is
              // this request's Referer, so this one same-origin POST carries it.
              referrerPolicy: "same-origin",
              credentials: "same-origin",
              cache: "no-store",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ granted, policyVersion: AD_POLICY_VERSION }),
            }),
          );
          if (state !== (granted ? "accepted" : "denied")) throw new Error("consent_not_saved");
          if (current === revision) {
            blockedLocally = !granted;
            publish({ state, pending: false, error: false });
          }
        } catch {
          if (current === revision) publish({ state: "denied", pending: false, error: true });
        }
      });
      writes = operation;
      return operation;
    },
  };
}

export const adConsent = createAdConsentStore((...args) => fetch(...args));
