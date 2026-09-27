import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("auth.md for agents", () => {
  it("documents both credential systems and the OAuth discovery documents", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("api-mepmail.je4ndev.com/.well-known/oauth-protected-resource");
    expect(body).toContain("mepmail.je4ndev.com/.well-known/oauth-authorization-server");
    expect(body).toContain("restricted_api_key");
    expect(body).not.toContain("millionsend.com");
  });
});
