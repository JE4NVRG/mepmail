import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("api-catalog (RFC 9727 linkset)", () => {
  it("links the API anchor to its OpenAPI definition and docs", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/linkset+json");
    const body = await res.json();
    const [linkset] = body.linkset;
    expect(linkset.anchor).toBe("https://api-mepmail.je4ndev.com/");
    expect(linkset["service-desc"][0].href).toBe("https://api-mepmail.je4ndev.com/openapi.json");
    expect(JSON.stringify(body)).not.toContain("millionsend.com");
  });
});
