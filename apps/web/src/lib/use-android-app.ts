"use client";

import { useEffect, useState } from "react";
import { inAndroidApp } from "./android-app";

/** For React: false on the server and during hydration, then the tab's real mode. */
export function useInAndroidApp(): boolean {
  const [app, setApp] = useState(false);
  useEffect(() => setApp(inAndroidApp()), []);
  return app;
}
