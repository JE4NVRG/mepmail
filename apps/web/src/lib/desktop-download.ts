/**
 * Where people get the desktop app. On Windows the Microsoft Store copy is the
 * default: Microsoft signs it (no SmartScreen warning) and the Store keeps it
 * updated. The direct installer (app/desktop/correio/windows, self-updating)
 * stays for PCs where the Store is blocked. Linux has a page with the .deb,
 * .rpm and AppImage (app/desktop/correio/linux).
 */
export const WINDOWS_STORE_URL = "https://apps.microsoft.com/detail/9nhpx6qrf0pb";
export const WINDOWS_INSTALLER_URL = "/desktop/correio/windows";
export const LINUX_DOWNLOAD_URL = "/desktop/correio/linux";

export type DesktopAppPlatform = "windows" | "linux";

/**
 * The desktop app to offer in this browser: Windows or Linux, from the user
 * agent. Nothing inside the app itself, on phones (Android says "Linux" too)
 * or on other systems.
 */
export function desktopAppFor(userAgent: string, insideApp: boolean): DesktopAppPlatform | null {
  if (insideApp) return null;
  if (/Windows/.test(userAgent)) return "windows";
  if (/Linux/.test(userAgent) && !/Android/.test(userAgent)) return "linux";
  return null;
}
