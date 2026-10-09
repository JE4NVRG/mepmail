/**
 * The desktop shell (apps/desktop, Tauri 2) marks its webview with
 * `window.__MEPMAIL_DESKTOP__` and `<html data-mepmail-desktop>` from an
 * initialization script, and grants this origin a few Tauri commands
 * (core:default, core:window:allow-set-title, notification:default). The web
 * app adapts only through this module, so every call is a no-op in a browser
 * and during server rendering.
 *
 * The Tauri IPC is a fetch to http://ipc.localhost (Windows) or
 * ipc://localhost, which next.config.ts allows in connect-src.
 */

export type DesktopInfo = { app: string; version: string; platform: string };

type TauriInternals = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

declare global {
  interface Window {
    __MEPMAIL_DESKTOP__?: DesktopInfo;
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

/** The shell's identity, or null outside the desktop app. */
export function desktopInfo(): DesktopInfo | null {
  if (typeof window === "undefined") return null;
  const info = window.__MEPMAIL_DESKTOP__;
  return info && info.app === "mepmail-correio" ? info : null;
}

export function isDesktop(): boolean {
  return desktopInfo() !== null;
}

function ipc(): TauriInternals | null {
  if (!isDesktop()) return null;
  const internals = window.__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === "function" ? internals : null;
}

/**
 * Mirrors a title into the native window (the tab title does not reach it).
 * Resolves false outside the shell or when the shell refuses the command.
 */
export async function setNativeTitle(title: string): Promise<boolean> {
  const internals = ipc();
  if (!internals) return false;
  try {
    await internals.invoke("plugin:window|set_title", { label: "main", value: title });
    return true;
  } catch {
    return false;
  }
}

/**
 * A system notification. Inside the shell, Tauri's notification plugin backs
 * `window.Notification` with the native toast and grants permission on
 * request; in a browser the Web Notifications API is used only when the user
 * already granted it, never prompting.
 */
export async function notifyDesktop(title: string, body: string): Promise<boolean> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  try {
    let permission = Notification.permission;
    if (permission === "default" && isDesktop())
      permission = await Notification.requestPermission();
    if (permission !== "granted") return false;
    new Notification(title, { body, tag: "mepmail-correio-unread" });
    return true;
  } catch {
    return false;
  }
}
