import latest from "../../../../../public/desktop/correio/latest.json";

/**
 * The stable download link for the Correio Windows app:
 * https://mepmail.dev/desktop/correio/windows answers with the current
 * installer. The installer itself is a versioned file next to latest.json in
 * public/desktop/correio, so no cache can serve an old build under a new
 * name; latest.json is also what installed apps read to update themselves
 * (plugins.updater in apps/desktop/src-tauri/tauri.conf.json).
 */
export function GET() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: latest.platforms["windows-x86_64"].url,
      "Cache-Control": "public, max-age=300",
    },
  });
}
