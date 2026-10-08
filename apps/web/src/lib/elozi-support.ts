/** Public channel identifiers only. On since 2026-10-08: reception, assistant and FAQ are set in Elozi. */
export const ELOZI_SUPPORT_ORIGIN = "https://elozi.je4ndev.com";
export const ELOZI_SUPPORT_MODULE = `${ELOZI_SUPPORT_ORIGIN}/widget.js`;
export const eloziSupportChannel = {
  enabled: true,
  tenantId: "499f0367-4860-4fd1-98b3-3b1c90883a2f",
  channelId: "6376dfa3-1def-441e-bb46-e9d99fb64d4b",
};

export type EloziSupportChannel = { enabled: boolean; tenantId: string; channelId: string };
export type EloziSupportConfig = { tenantId: string; channelId: string };
export type EloziSupportStatus = "loading" | "opened" | "error";
type WidgetHandle = { open: () => void; destroy: () => void };
type WidgetModule = {
  createWebchatWidget: (options: EloziSupportConfig & { apiOrigin: string }) => WidgetHandle;
};

export function resolveEloziSupportChannel(
  channel: EloziSupportChannel = eloziSupportChannel,
): EloziSupportConfig | null {
  const identifier = /^[A-Za-z0-9_-]{1,120}$/;
  return channel.enabled && identifier.test(channel.tenantId) && identifier.test(channel.channelId)
    ? { tenantId: channel.tenantId, channelId: channel.channelId }
    : null;
}

async function loadWidget(): Promise<WidgetModule> {
  // The public factory is page scoped. A self-mounting script tag would leave
  // its body host alive after a client navigation and cannot remount cached ESM.
  return import(/* webpackIgnore: true */ ELOZI_SUPPORT_MODULE);
}

/** Visitor capabilities remain in the widget closure; no account identity is passed. */
export function createEloziSupportSession(
  config: EloziSupportConfig,
  onStatus: (status: EloziSupportStatus) => void,
  load: () => Promise<WidgetModule> = loadWidget,
) {
  const validConfig = resolveEloziSupportChannel({ enabled: true, ...config });
  let disposed = false;
  let widget: WidgetHandle | null = null;
  let pending: Promise<boolean> | null = null;
  const notify = (status: EloziSupportStatus) => {
    if (!disposed) onStatus(status);
  };
  const start = async () => {
    if (!validConfig) return false;
    try {
      if (!widget) {
        const module = await load();
        if (disposed) return false;
        widget = module.createWebchatWidget({
          apiOrigin: ELOZI_SUPPORT_ORIGIN,
          tenantId: validConfig.tenantId,
          channelId: validConfig.channelId,
        });
      }
      widget.open();
      notify("opened");
      return true;
    } catch {
      widget?.destroy();
      widget = null;
      notify("error");
      return false;
    }
  };
  return {
    open(): Promise<boolean> {
      if (disposed) return Promise.resolve(false);
      if (!validConfig) {
        notify("error");
        return Promise.resolve(false);
      }
      if (pending) return pending;
      notify("loading");
      pending = start().finally(() => {
        pending = null;
      });
      return pending;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      widget?.destroy();
      widget = null;
    },
  };
}
