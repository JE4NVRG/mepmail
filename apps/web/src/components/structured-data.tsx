import { type JsonLd, jsonLdDocument } from "@/lib/structured-data";

/** The page's schema.org graph as one JSON-LD script (see lib/structured-data.ts). */
export function StructuredData({ graph }: { graph: JsonLd[] }) {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized JSON with `<` escaped, no markup
      dangerouslySetInnerHTML={{ __html: jsonLdDocument(graph) }}
    />
  );
}
