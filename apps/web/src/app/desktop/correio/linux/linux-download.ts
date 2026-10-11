import latest from "../../../../../public/desktop/correio/latest.json";

export type LinuxBundle = "appimage" | "deb" | "rpm";

/** The updater's keys in latest.json ({os}-{arch}-{bundle type}). */
export const LINUX_PLATFORMS = {
  appimage: "linux-x86_64-appimage",
  deb: "linux-x86_64-deb",
  rpm: "linux-x86_64-rpm",
} as const satisfies Record<LinuxBundle, keyof typeof latest.platforms>;

/** The current file for a bundle: its URL and its file name. */
export function linuxFile(bundle: LinuxBundle): { url: string; name: string } {
  const url = latest.platforms[LINUX_PLATFORMS[bundle]].url;
  return { url, name: url.slice(url.lastIndexOf("/") + 1) };
}

/**
 * The stable Linux download links (https://mepmail.dev/desktop/correio/linux/
 * appimage, /deb and /rpm) answer with the file latest.json names for that
 * bundle. The files are assets of the GitHub release desktop-v<version>: the
 * AppImage carries its own WebKitGTK (about 80 MB), too big for the web image.
 * Installed apps read the same entries to update themselves.
 */
export function linuxDownload(bundle: LinuxBundle): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: linuxFile(bundle).url,
      "Cache-Control": "public, max-age=300",
    },
  });
}
