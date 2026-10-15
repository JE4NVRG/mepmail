/** Public channel identifiers; no identity secret is shipped to the browser. */
export const ELOZI_SUPPORT_ORIGIN = "https://elozi.je4ndev.com";
export const ELOZI_SUPPORT_MODULE = `${ELOZI_SUPPORT_ORIGIN}/widget.js`;
export const ELOZI_SAAS_SUPPORT_MODULE = `${ELOZI_SUPPORT_ORIGIN}/widget-saas.js`;
export const eloziSupportChannel = {
  enabled: true,
  tenantId: "499f0367-4860-4fd1-98b3-3b1c90883a2f",
  channelId: "6376dfa3-1def-441e-bb46-e9d99fb64d4b",
};

export type EloziSupportChannel = { enabled: boolean; tenantId: string; channelId: string };
export type EloziSupportConfig = { tenantId: string; channelId: string };
export type EloziSupportStatus = "loading" | "opened" | "error";
export type SupportIdentity = { accountId: string; userId: string };
export type SupportIdentityResponse = { token: string; identity: SupportIdentity };
type WidgetHandle = { open: () => void | Promise<unknown>; destroy: () => void };
type SaasHandle = WidgetHandle & { setAccount: (identity: SupportIdentity | null) => boolean };
type WidgetModule = {
  createWebchatWidget?: (options: EloziSupportConfig & { apiOrigin: string }) => WidgetHandle;
  createSaasWebchat?: (
    options: EloziSupportConfig & {
      apiOrigin: string;
      identity: SupportIdentity;
      requestTimeoutMs: number;
      getIdentityToken: (expected: SupportIdentity) => Promise<string>;
    },
  ) => SaasHandle;
};
type IdentityProvider = (expected?: SupportIdentity) => Promise<SupportIdentityResponse>;

/** Cookie session only. Expected identity is a guard, never an authorization input. */
export const ELOZI_IDENTITY_ENDPOINT = "/api/support/identity";
export async function fetchEloziIdentity(
  expected?: SupportIdentity,
  fetchImpl: typeof fetch = fetch,
): Promise<SupportIdentityResponse> {
  const query = expected ? `?${new URLSearchParams(expected)}` : "";
  const response = await fetchImpl(`${ELOZI_IDENTITY_ENDPOINT}${query}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Support identity unavailable");
  const body = (await response.json()) as Partial<SupportIdentityResponse>;
  if (
    typeof body.token !== "string" ||
    !body.token ||
    typeof body.identity?.accountId !== "string" ||
    !body.identity.accountId ||
    typeof body.identity.userId !== "string" ||
    !body.identity.userId ||
    (expected &&
      (expected.accountId !== body.identity.accountId || expected.userId !== body.identity.userId))
  ) {
    throw new Error("Support identity changed or invalid");
  }
  return { token: body.token, identity: body.identity };
}

/** Kept for callers of the old helper; absence now fails closed. */
export async function fetchEloziIdentityToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  return (await fetchEloziIdentity(undefined, fetchImpl)).token;
}

export function resolveEloziSupportChannel(
  channel: EloziSupportChannel = eloziSupportChannel,
): EloziSupportConfig | null {
  const identifier = /^[A-Za-z0-9_-]{1,120}$/;
  return channel.enabled && identifier.test(channel.tenantId) && identifier.test(channel.channelId)
    ? { tenantId: channel.tenantId, channelId: channel.channelId }
    : null;
}

async function loadWidget(): Promise<WidgetModule> {
  return import(/* webpackIgnore: true */ ELOZI_SUPPORT_MODULE);
}
async function loadSaas(): Promise<WidgetModule> {
  return import(/* webpackIgnore: true */ ELOZI_SAAS_SUPPORT_MODULE);
}

/** One lifecycle per page; the SaaS manager discards old account/user capabilities. */
export function createEloziSupportSession(
  config: EloziSupportConfig,
  onStatus: (status: EloziSupportStatus) => void,
  load?: () => Promise<WidgetModule>,
  identity?: IdentityProvider,
) {
  const validConfig = resolveEloziSupportChannel({ enabled: true, ...config });
  let disposed = false;
  let widget: WidgetHandle | SaasHandle | null = null;
  let pending: Promise<boolean> | null = null;
  let generation = 0;
  // The account/user this window's chat holds, and the capability it belongs to: a
  // sign-out or team switch heard from any window (invalidate) ends that capability at
  // once, panel open or closed, and every late callback of the old one is refused.
  let active: SupportIdentity | null = null;
  let capability = 0;
  // The person asked for the chat here (open) and has not signed out since. After a
  // sign-out, nothing reopens by itself (focus, visibility, a late answer): only the
  // person opening it again, which needs a fresh identity from the server.
  let wanted = false;
  let ended = false;
  const same = (a: SupportIdentity | null, b: SupportIdentity | null | undefined) =>
    !!a && !!b && a.accountId === b.accountId && a.userId === b.userId;
  const notify = (status: EloziSupportStatus) => {
    if (!disposed) onStatus(status);
  };
  const current = (owner: number) => !disposed && owner === generation;
  const reconcile = async (): Promise<boolean> => {
    if (!identity || disposed || ended) return false;
    // A team switch interrupted the first opening (identity or widget import still
    // pending): nothing was mounted, so open again for the new account.
    if (!widget) return wanted ? openChat() : false;
    const owner = ++generation;
    try {
      const account = await identity();
      if (!current(owner)) return false;
      active = account.identity;
      const changed = (widget as SaasHandle).setAccount(account.identity);
      if (changed) await widget.open();
      if (!current(owner)) return false;
      notify("opened");
      return true;
    } catch {
      if (current(owner)) {
        active = null;
        (widget as SaasHandle).setAccount(null);
        notify("error");
      }
      return false;
    }
  };
  const start = async () => {
    if (!validConfig) return false;
    const owner = ++generation;
    try {
      // Resolve the active membership before mounting anything identified.
      const account = identity ? await identity() : null;
      if (!current(owner)) return false;
      if (account) active = account.identity;
      if (!widget) {
        const module = await (load ?? (identity ? loadSaas : loadWidget))();
        if (!current(owner)) return false;
        const options = { apiOrigin: ELOZI_SUPPORT_ORIGIN, ...validConfig };
        if (identity && account) {
          if (!module.createSaasWebchat) throw new Error("SaaS widget unavailable");
          widget = module.createSaasWebchat({
            ...options,
            identity: account.identity,
            requestTimeoutMs: 15_000,
            // A late callback for an account this window no longer holds is refused
            // here, before and after the request (the server refuses it too: 409/401).
            getIdentityToken: async (expected) => {
              const held = capability;
              if (!same(active, expected)) throw new Error("Support identity changed");
              const answer = await identity(expected);
              if (disposed || held !== capability || !same(active, expected))
                throw new Error("Support identity changed");
              return answer.token;
            },
          });
        } else {
          if (!module.createWebchatWidget) throw new Error("Visitor widget unavailable");
          widget = module.createWebchatWidget(options);
        }
      } else if (account) {
        (widget as SaasHandle).setAccount(account.identity);
      }
      await widget.open();
      if (!current(owner)) return false;
      notify("opened");
      return true;
    } catch {
      if (current(owner)) {
        widget?.destroy();
        widget = null;
        notify("error");
      }
      return false;
    }
  };
  function openChat(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (!validConfig) {
      notify("error");
      return Promise.resolve(false);
    }
    if (pending) return pending;
    notify("loading");
    const request = start().finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  }
  return {
    /** The person opens the chat (also after a sign-out: a fresh identity decides). */
    open(): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      ended = false;
      wanted = true;
      return openChat();
    },
    reconcile,
    /**
     * The account ended (signed out) or changed (another team, a sign-in) in some window:
     * the old capability goes now, whether or not the chat panel is open. The signal only
     * revokes: it never asks for an identity nor mounts a chat. An opening interrupted by
     * a change resumes on the next focus/visibility reconcile or open, through the
     * verified endpoint; after a sign-out nothing reopens until the person opens it.
     */
    invalidate(kind: "signed-out" | "account-changed" = "signed-out") {
      if (!identity || disposed) return;
      capability++;
      generation++;
      active = null;
      // An opening still waiting (identity or widget import) belongs to the old account:
      // the next open or reconcile starts afresh instead of joining it.
      pending = null;
      const shown = wanted || widget !== null;
      if (widget && "setAccount" in widget) widget.setAccount(null);
      if (kind === "signed-out") {
        ended = true;
        wanted = false;
      }
      // Closed, with "reopen" available; never "loading": nothing loads until a reconcile
      // or an open asks the server for the current account.
      if (shown) notify("error");
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      generation++;
      widget?.destroy();
      widget = null;
    },
  };
}
