import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBaseUrl, mcpResourceUrl, mcpResourceUrls, mcpServerUrl } from "@/lib/api-base-url";

afterEach(() => vi.unstubAllEnvs());

describe("printed API base and MCP URL vs the canonical OAuth resource", () => {
  it("prints PUBLIC_API_URL when no advertised host is set", () => {
    vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");
    vi.stubEnv("PUBLIC_API_URL", "https://api-mepmail.je4ndev.com");
    vi.stubEnv("ADVERTISED_API_URL", undefined);
    expect(apiBaseUrl()).toBe("https://api-mepmail.je4ndev.com");
    expect(mcpResourceUrl()).toBe("https://api-mepmail.je4ndev.com/mcp");
    expect(mcpServerUrl()).toBe("https://api-mepmail.je4ndev.com/mcp");
    expect(mcpResourceUrls()).toEqual(["https://api-mepmail.je4ndev.com/mcp"]);
  });

  it("prints the advertised host while MCP tokens stay bound to PUBLIC_API_URL", () => {
    vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");
    vi.stubEnv("PUBLIC_API_URL", "https://api-mepmail.je4ndev.com");
    vi.stubEnv("ADVERTISED_API_URL", "https://api.mepmail.dev/");
    expect(apiBaseUrl()).toBe("https://api.mepmail.dev");
    expect(`${apiBaseUrl()}/mcp/correio`).toBe("https://api.mepmail.dev/mcp/correio");
    expect(mcpResourceUrl()).toBe("https://api-mepmail.je4ndev.com/mcp");
    // The MCP URL shown moves to the brand host; both stay registered.
    expect(mcpServerUrl()).toBe("https://api.mepmail.dev/mcp");
    expect(mcpResourceUrls()).toEqual([
      "https://api.mepmail.dev/mcp",
      "https://api-mepmail.je4ndev.com/mcp",
    ]);
  });
});
