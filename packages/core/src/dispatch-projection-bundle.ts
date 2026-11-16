/** Lossless DATA envelope for distinct representations of one dispatch snapshot.
 * Single-representation requests retain the qualified judge block byte for byte.
 * JSON escaping prevents message content from forging representation boundaries.
 * The adapter still enforces its complete-wire request bound; never truncate here.
 */
export function bundleDispatchProjectionBlocks(blocks: readonly string[]): string {
  const distinct = [...new Set(blocks)];
  if (distinct.length === 0) throw new Error("empty dispatch projections");
  if (distinct.length === 1) return distinct[0] as string;
  return JSON.stringify({ dispatchRepresentations: distinct });
}
