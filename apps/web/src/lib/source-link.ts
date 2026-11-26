/**
 * Controls visibility of header/footer links to `/source` (corresponding AGPL source download).
 * Defaults to enabled; operators may temporarily disable via `SHOW_SOURCE_LINK=false`
 * (and `NEXT_PUBLIC_SHOW_SOURCE_LINK=false` for client-rendered nav) while aligning a release archive.
 */
export function showSourceLinkEnabled(): boolean {
  return (
    process.env.SHOW_SOURCE_LINK !== "false" && process.env.NEXT_PUBLIC_SHOW_SOURCE_LINK !== "false"
  );
}
