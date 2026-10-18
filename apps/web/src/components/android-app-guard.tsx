"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  ANDROID_APP_ATTRIBUTE,
  ANDROID_APP_HOME,
  inAndroidApp,
  isAndroidAppSalesPath,
  keepAndroidAppMark,
} from "@/lib/android-app";

/**
 * Inside the Android app, a client-side navigation to a public sales page (the home, the
 * pricing, the Correio offer) goes to the Correio instead. A full page load is handled
 * earlier, before the first paint, by the init script in the root layout.
 *
 * It also keeps the `data-android-app` mark on <html>, which hides the purchase surfaces:
 * when a hydration error makes React render the page again on the client, React 19 clears
 * every attribute of <html>, the mark included.
 */
export function AndroidAppGuard() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (!inAndroidApp()) return;
    keepAndroidAppMark();
    const observer = new MutationObserver(keepAndroidAppMark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [ANDROID_APP_ATTRIBUTE],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (inAndroidApp() && isAndroidAppSalesPath(pathname)) router.replace(ANDROID_APP_HOME);
  }, [pathname, router]);
  return null;
}
