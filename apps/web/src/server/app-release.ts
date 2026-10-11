import changelog from "../../messages/en/changelog.json";
import type { AppRelease } from "../components/app-release";

/**
 * The running release: the newest entry of the public changelog, which every
 * release writes together with its code, and the source revision the server
 * was built from. Read on the server only (the changelog stays out of the
 * client bundles).
 */
export function currentRelease(): AppRelease {
  const [latest] = (changelog as { releases: { version: string; date: string }[] }).releases;
  return {
    version: latest?.version ?? null,
    date: latest?.date ?? null,
    revision: process.env.MILLIONSEND_REVISION ?? null,
  };
}
