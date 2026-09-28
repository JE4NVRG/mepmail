import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "@/app/(dashboard)/settings/mcp/mcp-tools";

/**
 * The settings → MCP page lists the tools the API's MCP server registers.
 * The registry lives in apps/api/src/mcp.ts (which apps/web cannot import),
 * so this parses the registrations out of its source to catch drift.
 */
describe("MCP tools manifest", () => {
  it("matches the tool registrations in apps/api/src/mcp.ts", () => {
    const source = readFileSync(join(__dirname, "../../api/src/mcp.ts"), "utf8");
    const registered = [...source.matchAll(/tool\(\s*"([a-z_]+)",\s*"([a-z-]+:[a-z]+)"/g)].map(
      ([, name, scope]) => ({ name, scope }),
    );
    expect(registered.length).toBeGreaterThan(0);
    expect(MCP_TOOLS.map(({ name, scope }) => ({ name, scope }))).toEqual(registered);
  });

  /**
   * The docs publish the same registry to the outside world — content/docs/mcp.mdx
   * and its pt-BR mirror — and that table is what a client author reads before
   * writing an integration. apps/docs guards its own build with
   * scripts/check-mcp-parity.ts, but the pull-request gate runs the web suite,
   * so the same drift is asserted here, where CI actually looks.
   */
  const PAGES = [
    { page: "docs/content/docs/mcp.mdx", heading: "Tools" },
    { page: "docs/content/docs/mcp.pt-BR.mdx", heading: "Ferramentas" },
  ];

  /** Every tool the hosted server registers, scope included. */
  function registeredTools(): { name: string; scope: string }[] {
    const source = readFileSync(join(__dirname, "../../api/src/mcp.ts"), "utf8");
    const captured = (pattern: RegExp) =>
      [...source.matchAll(pattern)].flatMap((match) => {
        const [, name, scope] = match;
        return name === undefined ? [] : [{ name, scope: scope ?? "" }];
      });
    // Every tool goes through the local tool() helper, except list_teams, which
    // is registered straight on the server: no scope of its own, offered only
    // on an "All teams" grant.
    const tools = [
      ...captured(/\n\s+tool\(\n\s*"([a-z0-9_]+)",\n\s*"([a-z0-9:_-]+)",\n/g),
      ...captured(/\n {4}server\.registerTool\(\n\s*"([a-z0-9_]+)",\n/g),
    ];
    expect(
      tools.length,
      "the mcp.ts source shape changed and this test stopped reading it",
    ).toBeGreaterThan(50);
    return tools;
  }

  /** The tool rows of a page's table. */
  function documentedTools(page: string, heading: string): { name: string; scope: string }[] {
    const source = readFileSync(join(__dirname, "../../", page), "utf8");
    const section = new RegExp(`^## ${heading}$([\\s\\S]*?)(?=^## |\\Z)`, "m").exec(source)?.[1];
    expect(section, `no "## ${heading}" section in ${page}`).toBeTruthy();
    return [
      ...(section ?? "").matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*(`[a-z0-9:_-]+`|—)\s*\|/gm),
    ].flatMap((match) => {
      const [, name, permission] = match;
      if (name === undefined) return [];
      // The permission column carries the OAuth scope, or an em dash for the
      // one tool the server offers with no scope of its own.
      return [{ name, scope: permission === "—" ? "" : (permission ?? "").slice(1, -1) }];
    });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

  for (const { page, heading } of PAGES) {
    it(`documents every registered tool in ${page}`, () => {
      const documented = documentedTools(page, heading);
      expect(documented.length, `the tool table in ${page} stopped parsing`).toBeGreaterThan(50);
      expect([...documented].sort(byName)).toEqual([...registeredTools()].sort(byName));
    });
  }
});
