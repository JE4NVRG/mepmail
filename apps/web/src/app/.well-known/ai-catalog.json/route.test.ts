import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("ai-catalog.json", () => {
  it("advertises every agent-facing surface on the canonical hosts", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.specVersion).toBe("1.0");
    expect(body.host.identifier).toBe("mepmail.dev");
    const urls = body.entries.map((e: { url: string }) => e.url);
    expect(urls).toContain("https://mepmail.dev/.well-known/mcp/server-card.json");
    expect(urls).toContain("https://mepmail.dev/.well-known/api-catalog");
    expect(urls).toContain("https://mepmail.dev/.well-known/agent-skills/index.json");
    expect(urls).toContain("https://api.mepmail.dev/openapi.json");
    expect(urls).toContain("https://mepmail.dev/auth.md");
    expect(urls).toContain("https://mepmail.dev/correio");
    expect(urls).toContain("https://docs.mepmail.dev/mailboxes");
    const correio = body.entries.find(
      (e: { identifier: string }) => e.identifier === "urn:air:je4ndev.com:mepmail:correio:mcp",
    );
    expect(correio.description).toContain("https://api.mepmail.dev/mcp/correio");
    expect(JSON.stringify(body)).not.toContain("millionsend.com");
  });
});
