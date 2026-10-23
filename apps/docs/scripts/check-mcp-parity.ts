import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
 *
 * Pass `--npm` to also compare the in-repo manifests with `npm view`. The
 * /packages pages are generated from those manifests, so a publish that moves
 * ahead of them leaves the page on the old number. The docs image build does
 * not pass this flag: that build installs with `--offline` and must stay
 * reproducible without the registry.
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
const writeGenerated = process.argv.includes("--write");
const checkNpm = process.argv.includes("--npm");

async function readSource(path: string): Promise<string> {
  return readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
}

async function readManifest(
  path: string,
): Promise<{ name: string; version: string; engines: { node: string } }> {
  return JSON.parse(await readSource(path));
}

/** Generated Markdown stays useful on the agent-readable .md and llms surfaces. */
async function generatedBlock(page: string, name: string, body: string, problems: string[]) {
  const url = new URL(`../content/docs/${page}`, import.meta.url);
  const text = await readFile(url, "utf8");
  const start = `{/* ${name}:start */}`;
  const end = `{/* ${name}:end */}`;
  const first = text.indexOf(start);
  const last = text.indexOf(end);
  if (first === -1 || last < first) throw new Error(`${page}: missing ${name} markers`);
  const current = text.slice(first + start.length, last).replace(/\r\n/g, "\n");
  const expected = `\n${body}\n`;
  if (current === expected) return;
  if (writeGenerated) {
    await writeFile(url, `${text.slice(0, first + start.length)}${expected}${text.slice(last)}`);
  } else {
    problems.push(
      `${page}: stale ${name}; run pnpm exec tsx apps/docs/scripts/check-mcp-parity.ts --write from the repository root`,
    );
  }
}

/** `1.2.10` > `1.2.9`. Prerelease tags are out of scope for these packages. */
function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Latest stable version npm would install for `name` (`npm view <name> version`). */
function publishedVersion(name: string): string {
  const result = spawnSync("npm", ["view", name, "version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const version = result.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\d+\.\d+\.\d+$/.test(line));
  if (result.status !== 0 || !version) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw new Error(`npm view ${name} version failed (${result.status}): ${detail}`);
  }
  return version;
}

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

  // The Correio tools are defined once (packages/mcp/src/correio-tools.ts) and each is
  // registered by a `correioTool("name", "scope");` line with its mail scope.
  for (const call of source.matchAll(/\n\s+correioTool\("([a-z0-9_]+)", "([a-z0-9:_-]+)"\);/g)) {
    const name = call[1];
    const scope = call[2];
    if (name === undefined || scope === undefined) continue;
    registry.push({ name, scope, admin: false });
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

// Package pages and discovery use these same manifests/registries. A release
// cannot silently retain a previous version or tool count in either language.
const [mcpPackage, cliPackage, sdkPackage, cardSource, cardToolsSource, catalogSource] =
  await Promise.all([
    readManifest("packages/mcp/package.json"),
    readManifest("packages/cli/package.json"),
    readManifest("apps/api/node_modules/resend/package.json"),
    readSource("packages/core/src/mcp-server-card.ts"),
    readSource("packages/core/src/mcp-tools.ts"),
    readSource("apps/web/src/app/.well-known/ai-catalog.json/route.ts"),
  ]);
const hostedVersion = /MCP_SERVER_VERSION = "([^"]+)"/.exec(cardSource)?.[1];
if (!hostedVersion) throw new Error("could not read MCP_SERVER_VERSION");
const cardNames = captures(cardToolsSource, /\n\s+name: "([a-z0-9_]+)"/g);
// list_teams is conditional on an all-teams grant and has no OAuth scope of
// its own. The public card advertises the regular scoped tool surface.
const scopedRegistry = registry.filter((tool) => tool.scope !== null);
const runtimeNames = new Set(scopedRegistry.map((tool) => tool.name));
if (
  cardNames.length !== scopedRegistry.length ||
  cardNames.some((name) => !runtimeNames.has(name))
) {
  problems.push(
    "packages/core/src/mcp-tools.ts: server-card tools differ from the hosted runtime registry",
  );
}
if (
  !/import \{ MCP_SERVER_VERSION \} from "@millionsend\/core\/mcp-server-card"/.test(
    catalogSource,
  ) ||
  !/version: MCP_SERVER_VERSION/.test(catalogSource)
) {
  problems.push("ai-catalog.json must use the server card's MCP_SERVER_VERSION");
}
const localNames = await readLocalPackageTools();
const mailboxNames = parseStringList(
  await readSource("packages/mcp/src/correio-tools.ts"),
  "CORREIO_TOOL_NAMES",
  "packages/mcp/src/correio-tools.ts",
);
const lock = await readSource("pnpm-lock.yaml");
const pinnedSdkVersion =
  /\n {6}resend:\r?\n {8}specifier: [^\r\n]+\r?\n {8}version: (\d+\.\d+\.\d+)/.exec(lock)?.[1];
if (pinnedSdkVersion !== sdkPackage.version) {
  problems.push(
    `installed resend@${sdkPackage.version} differs from lockfile ${pinnedSdkVersion ?? "(not found)"}`,
  );
}

// /packages copies these manifests. Fail when npm has published something
// newer: that is how the page kept showing @mepmail/mcp 0.2.1.
if (checkNpm) {
  for (const item of [
    { name: mcpPackage.name, manifest: mcpPackage.version, file: "packages/mcp/package.json" },
    { name: cliPackage.name, manifest: cliPackage.version, file: "packages/cli/package.json" },
  ]) {
    const latest = publishedVersion(item.name);
    const order = compareSemver(latest, item.manifest);
    if (order > 0) {
      problems.push(
        `${item.name}@${latest} is latest on npm, but ${item.file} is ${item.manifest}. ` +
          `/packages is generated from that manifest, so it still shows ${item.manifest}. ` +
          `Set the manifest to ${latest} and run ` +
          `pnpm exec tsx apps/docs/scripts/check-mcp-parity.ts --write.`,
      );
    } else if (order < 0) {
      console.log(
        `${item.name}: manifest ${item.manifest} is ahead of npm ${latest} ` +
          `(not published yet); /packages shows the source version.`,
      );
    } else {
      console.log(`${item.name}: npm ${latest} matches ${item.file}`);
    }
  }
  // n8n-nodes-mepmail is another repository. The page links to npm instead of
  // pinning a number, so a release there cannot turn this build red.
  console.log(`n8n-nodes-mepmail: npm ${publishedVersion("n8n-nodes-mepmail")}`);
}

for (const locale of ["en", "pt-BR"] as const) {
  const pt = locale === "pt-BR";
  const prefix = pt ? "/pt-BR" : "";
  const suffix = pt ? ".pt-BR" : "";
  const facts = [
    pt ? "| Pacote | Versão-fonte | Node | Papel |" : "| Package | Source version | Node | Role |",
    "| --- | --- | --- | --- |",
    `| [\`${mcpPackage.name}\`](https://www.npmjs.com/package/${mcpPackage.name}) | ${mcpPackage.version} | \`${mcpPackage.engines.node}\` | ${pt ? `${localNames.length} ferramentas da equipe e ${mailboxNames.length} de caixas Correio, conforme a credencial. [Guia](${prefix}/mcp).` : `${localNames.length} team tools and ${mailboxNames.length} mailbox tools, depending on the credential. [Guide](${prefix}/mcp).`} |`,
    `| [\`${cliPackage.name}\`](https://www.npmjs.com/package/${cliPackage.name}) | ${cliPackage.version} | \`${cliPackage.engines.node}\` | ${pt ? `Migração de contas com plano, aplicação e relatório. [Guia](${prefix}/cli).` : `Account migration with plan, apply and report. [Guide](${prefix}/cli).`} |`,
    `| [\`n8n-nodes-mepmail\`](https://www.npmjs.com/package/n8n-nodes-mepmail) | ${pt ? "[Consultar npm]" : "[See npm]"}(https://www.npmjs.com/package/n8n-nodes-mepmail) | n8n | ${pt ? `Workflows de envio e caixas Correio. [Guia](${prefix}/integrations#n8n).` : `Workflows for Send and Mail. [Guide](${prefix}/integrations#n8n).`} |`,
    "",
    pt
      ? `O [MCP hospedado](${prefix}/mcp) desta revisão é **${hostedVersion}**, com **${cardNames.length} ferramentas** anunciadas no [server card](https://mepmail.dev/.well-known/mcp/server-card.json). A ferramenta adicional \`list_teams\` só aparece em grants de todas as equipes. Escopos e permissões podem reduzir a lista efetiva.`
      : `The [hosted MCP](${prefix}/mcp) at this revision is **${hostedVersion}**, with **${cardNames.length} tools** advertised in the [server card](https://mepmail.dev/.well-known/mcp/server-card.json). The additional \`list_teams\` tool appears only on all-teams grants. Scopes and permissions can reduce the effective list.`,
  ].join("\n");
  await generatedBlock(`packages${suffix}.mdx`, "package-facts", facts, problems);
  const sdkFacts = [
    pt
      ? "| SDK | Runtime | Cobertura automatizada no repositório |"
      : "| SDK | Runtime | Automated repository coverage |",
    "| --- | --- | --- |",
    `| \`resend@${sdkPackage.version}\` (Node / TypeScript) | Node \`${sdkPackage.engines.node}\` | ${pt ? "[Suítes de contrato]" : "[Contract suites]"}(https://github.com/JE4NVRG/mepmail/tree/main/apps/api/test): emails, domains, contacts, contact properties, segments, broadcasts, suppressions, templates, topics, webhooks. |`,
  ].join("\n");
  await generatedBlock(`sdks${suffix}.mdx`, "sdk-compatibility", sdkFacts, problems);
}

if (problems.length > 0) {
  console.error("MCP tool parity check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${registry.length} tools are registered in apps/api/src/mcp.ts. Update the tables in apps/docs/content/docs/mcp.mdx and mcp.pt-BR.mdx to match.`,
  );
  process.exit(1);
}

console.log(
  `MCP parity: ${registry.length} hosted, ${localNames.length} local team and ${mailboxNames.length} mailbox tools; package versions and SDK ${sdkPackage.version} match both languages.`,
);
