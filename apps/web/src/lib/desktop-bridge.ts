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

/** "0.3.0" → [0, 3, 0]; anything unparsable counts as 0.0.0. */
function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
  return [major || 0, minor || 0, patch || 0];
}

/**
 * Whether HTML drag and drop reaches the page: always in a browser; in the
 * desktop shell from 0.3.0 on, which turned off the native file-drop handler
 * that used to swallow every drag (older installs update themselves).
 */
export function htmlDropsWork(): boolean {
  const info = desktopInfo();
  if (!info) return true;
  const [major, minor] = versionParts(info.version);
  return major > 0 || minor >= 3;
}

function ipc(): TauriInternals | null {
  if (!isDesktop()) return null;
  const internals = window.__TAURI_INTERNALS__;
  return internals && typeof internals.invoke === "function" ? internals : null;
}

/** Agents the desktop app can configure itself (apps/desktop/src-tauri/src/agents.rs). */
export const DESKTOP_AGENT_TARGETS = ["claude-desktop", "cursor", "claude-code", "codex"] as const;
export type DesktopAgentTarget = (typeof DESKTOP_AGENT_TARGETS)[number];
export type DesktopAgentResult =
  | { ok: true; detail: string }
  | { ok: false; reason: "cancelled" | "not_installed" | "unavailable" | "failed"; detail: string };

/** Whether this page may configure agents on the computer (the shell, with a mailbox key). */
export function canConnectAgentHere(token: string): boolean {
  return ipc() !== null && token.startsWith("mmb_");
}

/**
 * One click to connect an agent: the shell keeps the mailbox key in the
 * system's credential vault and writes the agent's MCP entry pointing at its
 * own executable (no key in any file). Each step shows a native "Permitir?";
 * a refusal comes back as "cancelled".
 */
export async function connectAgentHere(
  target: DesktopAgentTarget,
  mailboxId: string,
  token: string,
): Promise<DesktopAgentResult> {
  const internals = ipc();
  if (!internals) return { ok: false, reason: "unavailable", detail: "" };
  try {
    await internals.invoke("store_agent_key", { mailboxId, token });
    const result = (await internals.invoke("install_agent", { target, mailboxId })) as {
      detail?: unknown;
    } | null;
    return { ok: true, detail: typeof result?.detail === "string" ? result.detail : "" };
  } catch (error) {
    const detail = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    if (detail === "cancelled") return { ok: false, reason: "cancelled", detail };
    if (detail === "not_installed") return { ok: false, reason: "not_installed", detail };
    return { ok: false, reason: "failed", detail: detail.slice(0, 200) };
  }
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
