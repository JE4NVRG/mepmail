/**
 * The Android app (a Trusted Web Activity, package dev.mepmail.correio) shows this site full
 * screen. Under Google Play's payments policy nothing is sold inside it, and it carries no
 * advertising measurement; signing in, the mailboxes and the account settings work as on the
 * web.
 *
 * The app is recognized at the launch: Chrome sends the referrer
 * `android-app://dev.mepmail.correio`, and the start URL carries `?source=android`. It is
 * remembered for that tab only (sessionStorage). Chrome shares its cookies with the app, so a
 * cookie would carry the app mode into the person's regular browser; a tab-scoped flag
 * cannot. The inline script below runs before the first paint: it marks <html> with
 * `data-android-app` (CSS then hides every `[data-purchase]` element), it leaves the
 * public sales pages for the Correio, and it keeps the docs site out of the app.
 */
import { DOCS_URL } from "./docs-links";

export const ANDROID_APP_PACKAGE = "dev.mepmail.correio";
export const ANDROID_APP_STORAGE_KEY = "mepmail.android-app";
export const ANDROID_APP_ATTRIBUTE = "data-android-app";
/** Sent on the app's auth and tRPC requests, so the server refuses purchases and skips ads. */
export const ANDROID_APP_HEADER = "x-mepmail-client";
export const ANDROID_APP_HEADER_VALUE = "android-app";
/** Public pages that sell; inside the app they open the Correio instead. */
export const ANDROID_APP_SALES_PATHS: readonly string[] = [
  "/",
  "/pricing",
  "/correio",
  "/envio",
  "/alternatives/resend",
];
export const ANDROID_APP_HOME = "/mail";
/**
 * The docs site opens outside the app, lists the plans with their prices and links back to
 * the sales pages: a way to buy outside Google Play. Inside the app a docs link opens the
 * in-app help instead (the support page: its answers, the chat and the support e-mail).
 */
export const ANDROID_APP_DOCS_HOST = new URL(DOCS_URL).hostname;
export const ANDROID_APP_HELP = "/support";

/** Before the first paint (root layout). Plain ES5, no user input. */
export const ANDROID_APP_INIT_SCRIPT = `try{var s=window.sessionStorage,k=${JSON.stringify(ANDROID_APP_STORAGE_KEY)},q=new URLSearchParams(location.search);if(document.referrer.indexOf(${JSON.stringify(`android-app://${ANDROID_APP_PACKAGE}`)})===0||q.get("source")==="android")s.setItem(k,"1");if(s.getItem(k)==="1"){document.documentElement.setAttribute(${JSON.stringify(ANDROID_APP_ATTRIBUTE)},"");var p=location.pathname.replace(/\\/+$/,"")||"/";if(${JSON.stringify(ANDROID_APP_SALES_PATHS)}.indexOf(p)>=0)location.replace(${JSON.stringify(ANDROID_APP_HOME)});document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(a&&a.hostname===${JSON.stringify(ANDROID_APP_DOCS_HOST)}){e.preventDefault();location.assign(${JSON.stringify(ANDROID_APP_HELP)})}},true)}}catch(e){}`;

/** The tab flag the init script sets; storage can be blocked, and then there is none. */
function androidAppTab(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(ANDROID_APP_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this tab is the Android app (after the init script ran). The tab flag counts as
 * well as the mark on <html>: React 19 clears every attribute of <html> when a hydration
 * error makes it render the page again on the client (seen on /mail, error #418).
 */
export function inAndroidApp(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement?.hasAttribute?.(ANDROID_APP_ATTRIBUTE) === true || androidAppTab()
  );
}

/** Puts the mark back on <html> in the app when something removed it (the CSS needs it). */
export function keepAndroidAppMark(): void {
  if (typeof document === "undefined" || !androidAppTab()) return;
  const root = document.documentElement;
  if (root && !root.hasAttribute(ANDROID_APP_ATTRIBUTE)) {
    root.setAttribute(ANDROID_APP_ATTRIBUTE, "");
  }
}

/** A sales page that the app does not show (client-side navigations, too). */
export function isAndroidAppSalesPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return ANDROID_APP_SALES_PATHS.includes(path);
}

/** Headers marking a request from the app (empty on the web). */
export function androidAppHeaders(): Record<string, string> {
  return inAndroidApp() ? { [ANDROID_APP_HEADER]: ANDROID_APP_HEADER_VALUE } : {};
}

/** Server side: the request came from the Android app. */
export function isAndroidAppRequest(headers: Pick<Headers, "get"> | null | undefined): boolean {
  return headers?.get(ANDROID_APP_HEADER) === ANDROID_APP_HEADER_VALUE;
}
