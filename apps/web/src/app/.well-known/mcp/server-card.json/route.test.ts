import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "@/app/(dashboard)/settings/mcp/mcp-tools";
import { GET } from "./route";

const getBody = async () => await GET().json();

describe("mcp server-card.json", () => {
  it("points MCP clients at the hosted endpoint and its OAuth discovery", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.name).toBe("com.je4ndev/mepmail");
    expect(body.transport).toEqual({
      type: "streamable-http",
      url: "https://api-mepmail.je4ndev.com/mcp",
    });
    expect(body.authentication.type).toBe("oauth2");
    expect(body.authentication.scopes).toContain("emails:send");
    expect(body.authentication.resourceMetadata).toBe(
      "https://api-mepmail.je4ndev.com/.well-known/oauth-protected-resource",
    );
    expect(body.authentication.instructionsUrl).toBe("https://mepmail.dev/auth.md");
    expect(JSON.stringify(body)).not.toContain("millionsend.com");
  });

  it("carries the fields the server-card shape requires", async () => {
    const body = await getBody();
    // Smithery reads a static card to skip scanning an OAuth-protected
    // endpoint; the shape it documents is serverInfo + authentication +
    // tools. The MCP server-card draft adds $schema, version, transport and
    // capabilities, so every one of them is asserted here.
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
    expect(body.serverInfo.name).toBe("com.je4ndev/mepmail");
    expect(body.authentication.required).toBe(true);
    expect(body.authentication.schemes).toEqual(["oauth2"]);
    // An empty capabilities.tools is what made the card useless to a scanner.
    expect(body.capabilities.tools).toEqual({ listChanged: false });
  });

  it("lists every hosted tool with the API's own description", async () => {
    const body = await getBody();
    expect(body.tools.length).toBe(MCP_TOOLS.length);
    expect(body.tools.length).toBeGreaterThan(50);
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(
      MCP_TOOLS.map((tool) => tool.name),
    );
    // Only what the card can attest to: no invented inputSchema.
    expect(Object.keys(body.tools[0])).toEqual(["name", "description"]);
    for (const tool of body.tools) {
      expect(tool.description.trim().length, `${tool.name} has no description`).toBeGreaterThan(20);
    }
    const send = body.tools.find((tool: { name: string }) => tool.name === "send_email");
    expect(send.description).toBe(
      MCP_TOOLS.find((tool) => tool.name === "send_email")?.description,
    );
  });
});
