import { expect, it } from "vitest";
import { mcpResourceUrl } from "../src/oauth-scopes.js";

it("preserves the explicit MCP resource/audience across a web-origin migration", () => {
  const publicApi = "https://api-mepmail.je4ndev.com";
  for (const web of ["https://mepmail.je4ndev.com", "https://mepmail.dev"]) {
    expect(mcpResourceUrl(web, publicApi)).toBe(`${publicApi}/mcp`);
  }
});
