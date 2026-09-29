import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { cookieValue, parseAttributionCookie } from "@/lib/attribution";
import { visitSource } from "@/lib/public-funnel";
import { proxy } from "@/proxy";

vi.mock("@millionsend/config", () => ({ env: { UNSUBSCRIBE_BASE_URL: undefined } }));

function capture(url: string, cookie?: string, referer?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (referer) headers.set("referer", referer);
  return proxy(new NextRequest(url, { headers }));
}

const landing = "https://preview.example/?utm_source=reddit&utm_medium=post&utm_campaign=qa-local";

describe("attribution HTTP boundary", () => {
  it("serializes once and survives home to pricing to signup", () => {
    const header = capture(landing).headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^mm_attr=%7B%22source%22/);
    expect(header).toContain("Path=/");
    expect(header).toContain("Max-Age=7776000");
    expect(header).toContain("SameSite=lax");
    expect(header).toContain("Secure");
    expect(header).not.toContain("HttpOnly");
    const cookie = header.split(";")[0] ?? "";
    expect(visitSource(cookie)).toBe("reddit");
    for (const path of ["/pricing", "/signup"]) {
      expect(
        capture(`https://preview.example${path}`, cookie, "https://preview.example/").headers.get(
          "set-cookie",
        ),
      ).toBeNull();
      expect(visitSource(cookie)).toBe("reddit");
    }
  });

  it("keeps literal percent signs, encoded-looking text and unicode intact", () => {
    const campaign = 'ação 50% %22 "quoted"';
    const header =
      capture(`${landing}&utm_content=${encodeURIComponent(campaign)}`).headers.get("set-cookie") ??
      "";
    const cookie = header.split(";")[0] ?? "";
    expect(parseAttributionCookie(cookieValue(cookie, "mm_attr"))?.content).toBe(campaign);
    const request = new NextRequest("https://preview.example", { headers: { cookie } });
    expect(parseAttributionCookie(request.cookies.get("mm_attr")?.value)?.content).toBe(campaign);
  });

  it("reads legacy double encoding without permitting arbitrary recursive decoding", () => {
    const raw = JSON.stringify({ source: "reddit", campaign: "50% %22" });
    const once = encodeURIComponent(raw);
    const twice = encodeURIComponent(once);
    for (const value of [raw, once, twice]) {
      expect(parseAttributionCookie(value)).toEqual({ source: "reddit", campaign: "50% %22" });
    }
    expect(parseAttributionCookie(encodeURIComponent(twice))).toBeNull();
    for (const value of ["%", "not-json", "null", "[]", "42"]) {
      expect(parseAttributionCookie(value)).toBeNull();
    }
    expect(
      capture("https://preview.example/", `mm_attr=${twice}`, "https://other.example/").headers.get(
        "set-cookie",
      ),
    ).toBeNull();
    expect(
      visitSource(
        capture(landing.replace("reddit", "new-campaign"), `mm_attr=${twice}`).headers.get(
          "set-cookie",
        ),
      ),
    ).toBe("new-campaign");
  });

  it("keeps local HTTP readable and direct visits without attribution", () => {
    expect(capture(landing.replace("https:", "http:")).headers.get("set-cookie")).not.toContain(
      "Secure",
    );
    expect(capture("https://preview.example/").headers.get("set-cookie")).toBeNull();
  });
});
