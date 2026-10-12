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

  it("ignores unknown languages and never trusts the header a caller sends", () => {
    expect(forwarded("https://mepmail.dev/pricing?lang=fr")).toBeNull();
    expect(
      forwarded("https://mepmail.dev/pricing", { "x-mepmail-url-locale": "pt-BR" }),
    ).toBeNull();
  });
});
