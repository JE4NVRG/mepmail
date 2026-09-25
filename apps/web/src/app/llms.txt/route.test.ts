import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import { GET } from "./route";

describe("crawler entry points", () => {
  it("llms.txt points agents at the public docs source", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("https://docs-mepmail.agenciamep.com");
    expect(body).not.toContain("millionsend.com");
  });

  it("robots keeps crawlers off everything but the auth pages", () => {
    const rules = robots().rules;
    expect(Array.isArray(rules) ? rules[0] : rules).toEqual({
      userAgent: "*",
      allow: ["/login", "/signup"],
      disallow: "/",
    });
  });
});
