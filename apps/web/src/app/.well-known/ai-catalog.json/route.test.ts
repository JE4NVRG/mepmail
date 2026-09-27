import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("ai-catalog.json", () => {
  it("advertises every agent-facing surface on the canonical hosts", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.specVersion).toBe("1.0");
    expect(body.host.identifier).toBe("mepmail.je4ndev.com");
    const urls = body.entries.map((e: { url: string }) => e.url);
    expect(urls).toContain("https://mepmail.je4ndev.com/.well-known/mcp/server-card.json");
    expect(urls).toContain("https://mepmail.je4ndev.com/.well-known/api-catalog");
    expect(urls).toContain("https://api-mepmail.je4ndev.com/openapi.json");
    expect(urls).toContain("https://mepmail.je4ndev.com/auth.md");
    expect(JSON.stringify(body)).not.toContain("millionsend.com");
  });
});
