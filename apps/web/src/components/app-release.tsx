"use client";

import { createContext, useContext } from "react";

/** The release this page was rendered with: its number, date and source revision. */
export type AppRelease = {
  version: string | null;
  date: string | null;
  revision: string | null;
};

const AppReleaseContext = createContext<AppRelease>({ version: null, date: null, revision: null });

/** Set once by the layout (server/app-release.ts reads it), read anywhere below. */
export function AppReleaseProvider({
  release,
  children,
}: {
  release: AppRelease;
  children: React.ReactNode;
}) {
  return <AppReleaseContext.Provider value={release}>{children}</AppReleaseContext.Provider>;
}

export const useAppRelease = () => useContext(AppReleaseContext);
