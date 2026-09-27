import { describe, expect, it } from "vitest";
import { GET } from "./route";

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
    expect(body.authentication.instructionsUrl).toBe("https://mepmail.je4ndev.com/auth.md");
    expect(JSON.stringify(body)).not.toContain("millionsend.com");
  });
});
