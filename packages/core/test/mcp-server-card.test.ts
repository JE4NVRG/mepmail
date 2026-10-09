import { describe, expect, it } from "vitest";
import {
  MCP_SERVER_CARD,
  MCP_SERVER_CARD_CONTENT_TYPE,
  mcpServerCardBody,
} from "../src/mcp-server-card.js";
import { MCP_TOOLS } from "../src/mcp-tools.js";

/**
 * The card is served by two origins — the dashboard (apps/web) and the MCP
 * endpoint's own origin (apps/api). Both call this module, so these assertions
 * hold for both; the point of the module is that they cannot drift.
 */
describe("mcpServerCardBody", () => {
  const body = JSON.parse(mcpServerCardBody()) as typeof MCP_SERVER_CARD & {
    tools: { name: string; description: string }[];
  };

  it("serialises the exported card, pretty-printed", () => {
    expect(mcpServerCardBody()).toBe(`${JSON.stringify(MCP_SERVER_CARD, null, 2)}`);
    expect(mcpServerCardBody().startsWith("{\n")).toBe(true);
    expect(MCP_SERVER_CARD_CONTENT_TYPE).toBe("application/json; charset=utf-8");
  });

  it("carries the fields a scanner's static card needs", () => {
    for (const key of [
      "$schema",
      "version",
      "serverInfo",
      "capabilities",
      "transport",
      "authentication",
      "tools",
    ]) {
      expect(body, `missing ${key}`).toHaveProperty(key);
    }
    expect(body.serverInfo.name).toBe("io.github.JE4NVRG/mepmail");
    expect(body.name).toBe(body.serverInfo.name);
    expect(body.version).toBe(body.serverInfo.version);
    expect(body.authentication.required).toBe(true);
    // The field the Smithery static-card example reads.
    expect(body.authentication.schemes).toEqual(["oauth2"]);
    // An empty capabilities.tools is what made the card useless to a scanner.
    expect(body.capabilities.tools).toEqual({ listChanged: false });
  });

  it("keeps the discovery URLs on the endpoint's own origin", () => {
    const endpoint = new URL(body.transport.url);
    expect(body.transport.type).toBe("streamable-http");
    // The API registers exactly this path (apps/api/src/mcp.ts), and the
    // scanner follows it after the endpoint answers 401.
    expect(body.authentication.resourceMetadata).toBe(
      `${endpoint.origin}/.well-known/oauth-protected-resource`,
    );
    expect(body.authentication.authorizationServer).toBe("https://mepmail.dev");
    expect(body.authentication.authorizationServerMetadata).toBe(
      "https://mepmail.dev/.well-known/oauth-authorization-server",
    );
    // No legacy brand or host anywhere in the published card.
    expect(mcpServerCardBody()).not.toMatch(/millionsend|je4ndev\.com/i);
  });

  it("lists every registered tool, with its own description and nothing invented", () => {
    expect(body.tools.length).toBe(MCP_TOOLS.length);
    expect(body.tools.length).toBeGreaterThan(50);
    expect(body.tools.map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name));
    const send = body.tools.find((tool) => tool.name === "send_email");
    expect(send?.description).toBe(
      MCP_TOOLS.find((tool) => tool.name === "send_email")?.description,
    );
    for (const tool of body.tools) {
      expect(tool.description.trim().length, `${tool.name} has no description`).toBeGreaterThan(20);
      // The card is static: it attests to a name and a description, never to a
      // hand-written inputSchema the API would not recognise.
      expect(Object.keys(tool)).toEqual(["name", "description"]);
    }
  });
});
