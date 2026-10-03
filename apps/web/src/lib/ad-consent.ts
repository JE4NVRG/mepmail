export const AD_POLICY_VERSION = "meta-ads-v1" as const;
export type AdConsentState = "unknown" | "accepted" | "denied";
export interface AdConsentSnapshot {
  state: AdConsentState;
  pending: boolean;
  error: boolean;
}
const INITIAL: AdConsentSnapshot = { state: "unknown", pending: false, error: false };

/** Server cookie proof is authoritative. No local storage receipt or identifier. */
export function createAdConsentStore(request: typeof fetch) {
  let snapshot = INITIAL;
  let revision = 0;
  let blockedLocally = false;
  let reading: Promise<void> | undefined;
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
    read(): Promise<void> {
      if (snapshot.pending) return writes;
      if (reading) return reading;
      const current = revision;
      reading = (async () => {
        try {
          const state = await responseState(
            await request("/api/advertising-consent", {
              credentials: "same-origin",
              cache: "no-store",
            }),
          );
          if (current === revision)
            publish(
              blockedLocally && state === "accepted"
                ? { state: "denied", pending: false, error: true }
                : { state, pending: false, error: false },
            );
        } catch {
          if (current === revision) publish({ state: "unknown", pending: false, error: true });
        } finally {
          reading = undefined;
        }
      })();
      return reading;
    },
    blockLocally() {
      ++revision;
      blockedLocally = true;
      publish({ state: "denied", pending: false, error: true });
    },
    choose(granted: boolean): Promise<void> {
      const current = ++revision;
      blockedLocally = true;
      // Revoke synchronously, including while an earlier accept is still in flight.
      publish({ state: granted ? "unknown" : "denied", pending: true, error: false });
      const operation = writes.then(async () => {
        try {
          const state = await responseState(
            await request("/api/advertising-consent", {
              method: "POST",
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
