import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ApiDeps, createApi } from "@millionsend/api";
import { generateFiles } from "fumadocs-openapi";
import { openapi } from "../src/lib/openapi";

/**
 * Extracts the API's OpenAPI document straight from the route definitions and
 * renders one MDX page per operation, so the reference can never drift from
 * the code.
 *
 * Importing @millionsend/api opens no connections (queue/db/keyring live in
 * its server entrypoint, src/server.ts), but it transitively imports
 * @millionsend/config, which validates env at import time — so this script
 * must run with SKIP_ENV_VALIDATION=1, the same escape hatch apps/web's build
 * uses. The deps below are never dereferenced: createApi only registers
 * routes, and serving /openapi.json executes no route handler.
 */
const regions = (process.env.DOCS_API_REGIONS ?? "us-east-1")
  .split(",")
  .map((region) => region.trim())
  .filter(Boolean);
if (regions.length === 0) throw new Error("DOCS_API_REGIONS must contain at least one region");

const inertDeps: ApiDeps = {
  db: null as unknown as ApiDeps["db"],
  keyring: null as unknown as ApiDeps["keyring"],
  isCloud: true,
  enqueueEmailSend: async () => {},
  // Published docs describe Cloud, not the union of all self-host regions.
  // Self-host operators can set DOCS_API_REGIONS when building their docs;
  // their instance's /openapi.json remains authoritative for that deployment.
  // Only regions are read while registering routes; no SES call is made.
  ses: {
    regions,
    clientForRegion: () => {
      throw new Error("OpenAPI generation must not access SES");
    },
  },
};

const app = createApi(inertDeps);
const res = await app.request("/openapi.json");
if (!res.ok) throw new Error(`GET /openapi.json failed: ${res.status}`);
const document = await res.json();

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
await mkdir(publicDir, { recursive: true });
await writeFile(`${publicDir}/openapi.json`, `${JSON.stringify(document, null, 2)}\n`);

// Regenerate from scratch so removed endpoints leave no stale pages. Paths are
// cwd-relative and must stay in sync with src/lib/openapi.ts (see note there).
const endpointsDir = fileURLToPath(
  new URL("../content/docs/api-reference/endpoints", import.meta.url),
);
await rm(endpointsDir, { recursive: true, force: true });
await generateFiles({
  input: openapi,
  output: "./content/docs/api-reference/endpoints",
  groupBy: "route",
  includeDescription: true,
  // The body shows the full description; the frontmatter carries its first
  // sentence, in plain text, as the page's meta description.
  frontmatter: (_title, description) => {
    const summary = metaDescription(description);
    return summary ? { description: summary } : {};
  },
});

console.log("generated public/openapi.json and content/docs/api-reference/endpoints");

function metaDescription(text: string | undefined): string | undefined {
  const plain = text?.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return undefined;
  const first = plain.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? plain;
  return first.length > 200 ? `${first.slice(0, 197).trimEnd()}…` : first;
}
