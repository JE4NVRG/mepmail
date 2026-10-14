/**
 * The Correio on a phone's home screen, without a store (public/correio.webmanifest):
 * which phone this is, whether the Correio already runs from the home screen, and the
 * browser's own install prompt where it offers one (Chrome and Edge on Android). The
 * iPhone has no prompt: the person adds it from Safari's Share menu.
 */

export type PhoneAppPlatform = "ios" | "android";

/** The phone to explain the home-screen app for, or null (desktop, or already installed). */
export function phoneAppFor(userAgent: string, standalone: boolean): PhoneAppPlatform | null {
  if (standalone) return null;
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return null;
}

/** Whether the page runs as the installed home-screen app. */
export function runningStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
// The browser fires this once, early: keep it until the person asks to install.
if (typeof window !== "undefined")
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
  });

/** Whether the browser offered its install prompt (Android Chrome/Edge). */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Shows the browser's install prompt; true when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  return (await event.userChoice).outcome === "accepted";
}
