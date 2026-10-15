import type { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@/server/routers";

/**
 * The support chat's capability follows the signed-in account (Elozi contract v2:
 * account = team, user = person). The chat lives in its own window (/support/chat) or on
 * /support, so a sign-out or a team switch in the dashboard must reach those windows at
 * once, even when the chat panel is closed or the window is in the background, instead
 * of waiting for them to regain focus. Every window of this origin hears it through a
 * BroadcastChannel, with a localStorage event as the fallback; the chat drops the old
 * account's capability the moment it hears it.
 */
export type SupportSessionChange = "signed-out" | "account-changed";

const CHANNEL = "mepmail-support-session";
const STORAGE_KEY = "mepmail.support-session";
const LOCAL_EVENT = "mepmail-support-session-invalidated";
type Signal = { kind: SupportSessionChange; id: string };

function isSignal(value: unknown): value is Signal {
  const signal = value as Partial<Signal> | null;
  return (
    !!signal &&
    (signal.kind === "signed-out" || signal.kind === "account-changed") &&
    typeof signal.id === "string" &&
    signal.id.length > 0 &&
    signal.id.length <= 120
  );
}

/** Tells every window of this origin (this one included) that the account changed or ended. */
export function announceSupportSessionChange(kind: SupportSessionChange): void {
  if (typeof window === "undefined") return;
  const signal: Signal = { kind, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` };
  // Synchronous local revocation, including a closed panel. This event cannot authorize.
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: signal }));
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(signal);
    channel.close();
  } catch {
    // No BroadcastChannel: the storage event below still reaches the other windows.
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signal));
  } catch {
    // Storage blocked (private mode): the channel above is the only carrier.
  }
}

/** Listens for account changes from any window; each signal is handled once. */
export function onSupportSessionChange(handler: (kind: SupportSessionChange) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const seen = new Set<string>();
  let active = true;
  const deliver = (value: unknown) => {
    if (!active || !isSignal(value) || seen.has(value.id)) return;
    // Only retain bounded non-sensitive signal nonces, never account/user IDs or tokens.
    if (seen.size >= 128) seen.delete(seen.values().next().value!);
    seen.add(value.id);
    handler(value.kind);
  };
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => deliver(event.data);
  } catch {
    channel = null;
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue));
    } catch {
      // Not ours.
    }
  };
  const onLocal = (event: Event) => deliver((event as CustomEvent<unknown>).detail);
  window.addEventListener(LOCAL_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    if (!active) return;
    active = false;
    seen.clear();
    window.removeEventListener(LOCAL_EVENT, onLocal);
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
}

/** The auth client's sign-out request (better-auth POST /api/auth/sign-out). */
export function isSignOutRequest(url: URL | string): boolean {
  const path = typeof url === "string" ? url.split("?")[0]! : url.pathname;
  return /\/sign-out\/?$/.test(path);
}

/** The auth client's onRequest hook: a sign-out announces itself as it leaves. */
export function announceOnSignOutRequest(context: { url: URL | string }): void {
  if (isSignOutRequest(context.url)) announceSupportSessionChange("signed-out");
}

/** Sign-in changes the user scope as well; OAuth provider behavior remains unchanged. */
export function isSignInRequest(url: URL | string): boolean {
  try {
    return /\/(?:sign-in|sign-up)\/[^/]+\/?$/.test(
      new URL(String(url), "https://mepmail.dev").pathname,
    );
  } catch {
    return false;
  }
}

/** Compose the existing sign-out hook; signals only revoke and never mount a chat. */
export function announceOnAuthTransitionRequest(context: { url: URL | string }): void {
  announceOnSignOutRequest(context);
  if (isSignInRequest(context.url)) announceSupportSessionChange("account-changed");
}

/** Revoke again after commit/failure, covering a popup reopened while the request was pending. */
export function announceOnAuthTransitionSettled(context: { request: { url: URL | string } }): void {
  announceOnAuthTransitionRequest(context.request);
}

/** tRPC mutations that change the active team, so the chat's account. */
export const ACCOUNT_CHANGING_MUTATIONS: ReadonlySet<string> = new Set([
  "team.switch",
  "team.createTeam",
  "settings.invitations.accept",
]);

/** Invalidate at the start and end; the signal conveys no new-account authority. */
export const supportSessionLink: TRPCLink<AppRouter> =
  () =>
  ({ next, op }) =>
    observable((observer) => {
      const changing = op.type === "mutation" && ACCOUNT_CHANGING_MUTATIONS.has(op.path);
      let settled = false;
      if (changing) announceSupportSessionChange("account-changed");
      const finish = () => {
        if (changing && !settled) {
          settled = true;
          announceSupportSessionChange("account-changed");
        }
      };
      // Cancelled while pending (unsubscribed): the transport ends here and nothing it
      // answers later reaches the caller, even if it emits after the teardown. The server
      // may still have switched the team, so revoke once more; a signal only revokes and
      // never mounts or authorizes a chat.
      let cancelled = false;
      const subscription = next(op).subscribe({
        next(value) {
          if (cancelled) return;
          finish();
          observer.next(value);
        },
        error(error) {
          if (cancelled) return;
          finish();
          observer.error(error);
        },
        complete() {
          if (cancelled) return;
          finish();
          observer.complete();
        },
      });
      return () => {
        cancelled = true;
        subscription.unsubscribe();
        finish();
      };
    });
