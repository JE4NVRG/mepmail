import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("auth.md for agents", () => {
  it("documents both credential systems and the OAuth discovery documents", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("api.mepmail.dev/.well-known/oauth-protected-resource");
    expect(body).toContain("mepmail.dev/.well-known/oauth-authorization-server");
    expect(body).not.toMatch(/millionsend|je4ndev\.com/i);
    expect(body).toContain("restricted_api_key");
    expect(body).not.toContain("millionsend.com");
  });
});
