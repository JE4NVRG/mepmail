"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { ANDROID_APP_HOME, inAndroidApp, isAndroidAppSalesPath } from "@/lib/android-app";

/**
 * Inside the Android app, a client-side navigation to a public sales page (the home, the
 * pricing, the Correio offer) goes to the Correio instead. A full page load is handled
 * earlier, before the first paint, by the init script in the root layout.
 */
export function AndroidAppGuard() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (inAndroidApp() && isAndroidAppSalesPath(pathname)) router.replace(ANDROID_APP_HOME);
  }, [pathname, router]);
  return null;
}
