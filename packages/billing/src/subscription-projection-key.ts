/** Canonical JSON snapshot for projection CAS. JSONB objects have no key order;
 * arrays, primitive types, nulls and all binding/contract values still do.
 * Date serialization and unsupported-value behavior remain JSON.stringify's.
 */
export function canonicalProjectionKey(parts: readonly unknown[]): string {
  const result = JSON.stringify(parts, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return value;
  });
  if (typeof result !== "string") throw new Error("Projection snapshot unavailable");
  return result;
}
