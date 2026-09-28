import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Parity guard for the MCP tool tables the docs publish.
 *
 * The hosted MCP server registers its tools in apps/api/src/mcp.ts, and the
 * docs re-state every one of them by hand in content/docs/mcp.mdx (plus the
 * pt-BR mirror). Nothing connected the two, so a tool added, renamed or
 * re-scoped in the code silently left the page lying to readers — and that page
 * is where a client author learns which tools exist.
 *
 * This script reads the registry out of the source and fails (exit 1) when the
 * tables drift: a missing tool, a stale row, a wrong permission, or an admin
 * marker the code no longer agrees with. It runs before `next build`, so a docs
 * build cannot ship a table that disagrees with the server.
 *
 * Everything is parsed from source text on purpose: importing the API would
 * pull its whole dependency graph (env validation, db, keyring) into the docs
 * build just to read a list of tool names.
 */

type RegistryTool = { name: string; scope: string | null; admin: boolean };
type TableRow = { scope: string; line: string };

const SCOPES_URL = new URL("../../../packages/core/src/oauth-scopes.ts", import.meta.url);
const MCP_URL = new URL("../../../apps/api/src/mcp.ts", import.meta.url);
const LOCAL_PACKAGE_URL = new URL("../../../packages/mcp/src/tools.ts", import.meta.url);
const PAGES = [
  { path: "content/docs/mcp.mdx", heading: "Tools" },
  { path: "content/docs/mcp.pt-BR.mdx", heading: "Ferramentas" },
];

/** The first capture of every match of a global pattern, in order. */
function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Parses a `const NAME = ["a", "b"] as const` list out of a source file. */
function parseStringList(source: string, name: string, file: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
  const list = match?.[1];
  if (list === undefined) throw new Error(`could not find ${name} in ${file}`);
  return captures(list, /"([^"]+)"/g);
}

async function readRegistry(): Promise<RegistryTool[]> {
  const source = await readFile(fileURLToPath(MCP_URL), "utf8");
  const adminScopes = new Set(
    parseStringList(
      await readFile(fileURLToPath(SCOPES_URL), "utf8"),
      "ADMIN_MCP_SCOPES",
      "packages/core/src/oauth-scopes.ts",
    ),
  );

  // Every tool goes through the local `tool(name, scope, cfg, run)` helper,
  // except the one gated entirely behind an all-teams grant (list_teams),
  // registered straight on the server. Slicing each call up to the next one
  // keeps each flag read from the right block.
  const registry: RegistryTool[] = [];
  const calls = [...source.matchAll(/\n\s+tool\(\n\s*"([a-z0-9_]+)",\n\s*"([a-z0-9:_-]+)",\n/g)];
  for (const [index, call] of calls.entries()) {
    const name = call[1];
    const scope = call[2];
    if (name === undefined || scope === undefined) continue;
    const block = source.slice(call.index, calls[index + 1]?.index ?? source.length);
    const readOnly = /readOnly: true/.test(block);
    registry.push({
      name,
      scope,
      // Mirrors the helper: an explicit `admin: true`, or a write in an
      // admin-only scope (plain reads there stay open to members).
      admin: /admin: true/.test(block) || (adminScopes.has(scope) && !readOnly),
    });
  }

  // list_teams: no scope of its own — it exists only on an all-teams grant.
  for (const name of captures(source, /\n {4}server\.registerTool\(\n\s*"([a-z0-9_]+)",\n/g)) {
    registry.push({ name, scope: null, admin: false });
  }

  if (registry.length < 50) {
    throw new Error(
      `parsed only ${registry.length} tools out of apps/api/src/mcp.ts — the source shape changed and this check stopped reading it`,
    );
  }
  return registry;
}

/**
 * The local package (packages/mcp) re-implements a subset of the same tools
 * over the REST API. Its names must exist on the hosted server, or a client
 * moving a prompt between the two breaks.
 */
async function readLocalPackageTools(): Promise<string[]> {
  const names = captures(
    await readFile(fileURLToPath(LOCAL_PACKAGE_URL), "utf8"),
    /\n\s+name: "([a-z0-9_]+)"/g,
  );
  if (names.length < 5) {
    throw new Error(
      `parsed only ${names.length} tools out of packages/mcp/src/tools.ts — the source shape changed and this check stopped reading it`,
    );
  }
  return names;
}

/** The tool rows of a page's table, keyed by tool name. */
function readTable(source: string, heading: string, page: string): Map<string, TableRow> {
  const section = new RegExp(`^## ${heading}$([\\s\\S]*?)(?=^## |\\Z)`, "m").exec(source);
  const body = section?.[1];
  if (body === undefined) throw new Error(`no "## ${heading}" section in ${page}`);

  const rows = new Map<string, TableRow>();
  for (const row of body.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|([^|]*)\|([^\n]*)$/gm)) {
    const name = row[1];
    if (name === undefined) continue;
    const permission = (row[2] ?? "").trim();
    rows.set(name, {
      scope: /^`[a-z0-9:_-]+`$/.test(permission) ? permission.slice(1, -1) : "",
      line: row[0],
    });
  }
  if (rows.size < 50) {
    throw new Error(`parsed only ${rows.size} tool rows out of ${page} — the table shape changed`);
  }
  return rows;
}

const registry = await readRegistry();
const problems: string[] = [];

// The local npm package must not invent tool names of its own.
for (const name of await readLocalPackageTools()) {
  if (!registry.some((tool) => tool.name === name)) {
    problems.push(`packages/mcp/src/tools.ts: ${name} is not a tool the hosted server registers`);
  }
}

for (const page of PAGES) {
  const table = readTable(
    await readFile(new URL(`../${page.path}`, import.meta.url), "utf8"),
    page.heading,
    page.path,
  );

  for (const tool of registry) {
    const row = table.get(tool.name);
    if (!row) {
      problems.push(`${page.path}: ${tool.name} is registered in mcp.ts but has no row`);
      continue;
    }
    // The permission column carries the scope, or an em dash for the tool the
    // server offers with no scope of its own.
    if (row.scope !== (tool.scope ?? "")) {
      problems.push(
        `${page.path}: ${tool.name} documents permission "${row.scope || "—"}" but mcp.ts registers it as ${tool.scope ?? "— (no scope; all-teams grants only)"}`,
      );
    }
    if (row.line.includes("**admin**") !== tool.admin) {
      problems.push(
        tool.admin
          ? `${page.path}: ${tool.name} only reaches owners and admins in mcp.ts but its row is not marked **admin**`
          : `${page.path}: ${tool.name} is marked **admin** in the table but mcp.ts offers it to members`,
      );
    }
  }

  for (const name of table.keys()) {
    if (!registry.some((tool) => tool.name === name)) {
      problems.push(`${page.path}: the row for ${name} documents a tool mcp.ts does not register`);
    }
  }
}

if (problems.length > 0) {
  console.error("MCP tool parity check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${registry.length} tools are registered in apps/api/src/mcp.ts. Update the tables in apps/docs/content/docs/mcp.mdx and mcp.pt-BR.mdx to match.`,
  );
  process.exit(1);
}

console.log(`MCP tool parity: all ${registry.length} registered tools match both doc tables.`);
