import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

const request = (url: string) => new NextRequest(url, { headers: { host: new URL(url).host } });

describe("the unsubscribe host", () => {
  it("answers the unsubscribe flow and its assets, nothing else", () => {
    vi.stubEnv("UNSUBSCRIBE_BASE_URL", "https://unsubscribe.example.com");
    expect(proxy(request("https://unsubscribe.example.com/unsubscribe/abc.def")).status).toBe(200);
    expect(proxy(request("https://unsubscribe.example.com/unsubscribe/confirm/abc")).status).toBe(
      200,
    );
    expect(proxy(request("https://unsubscribe.example.com/logo/mepmail-favicon.svg")).status).toBe(
      200,
    );
    expect(proxy(request("https://unsubscribe.example.com/_next/static/x.css")).status).toBe(200);
    expect(proxy(request("https://unsubscribe.example.com/")).status).toBe(404);
    expect(proxy(request("https://unsubscribe.example.com/login")).status).toBe(404);
    expect(proxy(request("https://unsubscribe.example.com/api/auth/session")).status).toBe(404);
  });

  it("leaves the dashboard host alone, unsubscribe flow included", () => {
    vi.stubEnv("UNSUBSCRIBE_BASE_URL", "https://unsubscribe.example.com");
    expect(proxy(request("https://app.example.com/login")).status).toBe(200);
    expect(proxy(request("https://app.example.com/unsubscribe/abc.def")).status).toBe(200);
  });

  it("does nothing without a host of its own", () => {
    vi.stubEnv("UNSUBSCRIBE_BASE_URL", "");
    expect(proxy(request("https://app.example.com/login")).status).toBe(200);
  });
});

describe("the language a public URL names", () => {
  const forwarded = (url: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(url, { headers: { host: new URL(url).host, ...headers } })).headers.get(
      "x-middleware-request-x-mepmail-url-locale",
    );

  it("forwards ?lang= to the request config when it is a language we speak", () => {
    expect(forwarded("https://mepmail.dev/pricing?lang=pt-BR")).toBe("pt-BR");
    expect(forwarded("https://mepmail.dev/?lang=en")).toBe("en");
  });

  it("defaults canonical public URLs to English and never trusts caller headers", () => {
    expect(forwarded("https://mepmail.dev/pricing?lang=fr")).toBe("en");
    expect(forwarded("https://mepmail.dev/pricing", { "x-mepmail-url-locale": "pt-BR" })).toBe(
      "en",
    );
  });

  it.each(["/", "/pricing", "/correio", "/alternatives/resend", "/guides/transactional-email"])(
    "keeps %s English despite Portuguese preference or campaign parameters",
    (path) => {
      expect(
        forwarded(`https://mepmail.dev${path}?utm_source=fixture`, {
          cookie: "NEXT_LOCALE=pt-BR",
          "accept-language": "pt-BR,pt;q=0.9",
        }),
      ).toBe("en");
    },
  );

  it.each([
    "/login",
    "/signup?next=%2Femails",
    "/mail",
    "/mailboxes",
    "/api/auth/get-session",
    "/support/chat",
    "/guides/not-a-guide",
  ])("preserves preference negotiation outside canonical public pages: %s", (path) => {
    expect(forwarded(`https://mepmail.dev${path}`, { "x-mepmail-url-locale": "en" })).toBeNull();
  });

  it("does not change preference cookies or the requested auth return path", () => {
    const response = proxy(
      request("https://mepmail.dev/signup?next=%2Ftemplates%2Fnew%3Fstarter%3Dwelcome"),
    );
    expect(response.headers.get("x-middleware-request-x-mepmail-next")).toBe(
      "/signup?next=%2Ftemplates%2Fnew%3Fstarter%3Dwelcome",
    );
    expect(response.cookies.get("NEXT_LOCALE")).toBeUndefined();
  });
});
