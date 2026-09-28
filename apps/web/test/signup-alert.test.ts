import type { SignupAttribution } from "@millionsend/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPAIGN_SLUGS,
  notifySignupAlert,
  originLabel,
  signupAlertMessage,
} from "@/server/signup-alert";

const attribution = (over: Partial<SignupAttribution> = {}): SignupAttribution => ({
  source: "facebook",
  medium: "group",
  campaign: "beta-livia-202609",
  content: "react-brasil",
  term: null,
  referrer: null,
  landingPath: "/",
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("originLabel", () => {
  it("names the community a known utm_content maps to", () => {
    expect(originLabel(attribution())).toBe('facebook · grupo "React Brasil"');
  });

  it("keeps an unknown utm_content visible instead of dropping it", () => {
    expect(originLabel(attribution({ content: "grupo-novo-2027" }))).toBe(
      "facebook · utm_content=grupo-novo-2027",
    );
  });

  it("falls back to the network alone when the campaign carried no content", () => {
    expect(originLabel(attribution({ content: null }))).toBe("facebook");
  });

  it("says a signup with no cookie was not measured", () => {
    expect(originLabel(null)).toMatch(/sem cookie de atribuicao/);
  });

  it("adds the external referrer when it differs from the source", () => {
    expect(originLabel(attribution({ content: null, referrer: "news.ycombinator.com" }))).toBe(
      "facebook · via news.ycombinator.com",
    );
  });
});

describe("signupAlertMessage", () => {
  it("carries the address, the origin and the campaign", () => {
    const text = signupAlertMessage({
      email: "ada@example.com",
      name: "Ada",
      attribution: attribution(),
      locale: "pt-BR",
      now: new Date("2026-09-28T20:30:00Z"),
    });
    expect(text).toContain("ada@example.com");
    expect(text).toContain("Ada");
    expect(text).toContain('grupo "React Brasil"');
    expect(text).toContain("beta-livia-202609");
    expect(text).toContain("28/09/2026 17:30 (BRT)");
  });

  it("labels a direct signup honestly", () => {
    const text = signupAlertMessage({
      email: "bob@example.com",
      name: null,
      attribution: null,
      locale: "en",
    });
    expect(text).toContain("(sem nome)");
    expect(text).toContain("sem cookie de atribuicao");
    expect(text).toContain("Campanha: —");
  });
});

describe("notifySignupAlert", () => {
  it("sends nothing when the instance is not configured for alerts", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    notifySignupAlert({ email: "ada@example.com", name: "Ada" }, attribution(), "pt-BR");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the Bot API chat when configured, with the thread when set", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-VALUE-000000000000000000000");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-1003838851729");
    vi.stubEnv("TELEGRAM_MESSAGE_THREAD_ID", "1");
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    notifySignupAlert({ email: "ada@example.com", name: "Ada" }, attribution(), "pt-BR");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/bot123456:TEST-TOKEN-VALUE-000000000000000000000/sendMessage");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.chat_id).toBe("-1003838851729");
    expect(body.message_thread_id).toBe(1);
    expect(String(body.text)).toContain("React Brasil");
  });

  it("never rejects when the Bot API refuses", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:TEST-TOKEN-VALUE-000000000000000000000");
    vi.stubEnv("TELEGRAM_CHAT_ID", "42");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      notifySignupAlert({ email: "ada@example.com", name: "Ada" }, null, "pt-BR"),
    ).not.toThrow();
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });
});

describe("CAMPAIGN_SLUGS", () => {
  it("maps every slug to a non-empty label", () => {
    for (const [slug, label] of Object.entries(CAMPAIGN_SLUGS)) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });
});
