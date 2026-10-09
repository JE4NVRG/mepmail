import { describe, expect, it, vi } from "vitest";
import type { AdConsentState } from "@/lib/ad-consent";
import {
  createGooglePublicController,
  GOOGLE_TAG_ID,
  type GoogleCommand,
  googleReferrer,
  loadGoogleTag,
  safeGoogleContext,
  safeGoogleUrl,
} from "@/lib/google-public-events";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
// What the Search campaign's final URL suffix plus auto-tagging produce.
const adUrl =
  "https://mepmail.dev/?utm_source=google&utm_medium=cpc&utm_campaign=search_br_pt&utm_content=187654321098&utm_term=servi%C3%A7o%20de%20email%20transacional&gad_source=1&gad_campaignid=23071234567&gclid=Cj0KCQjw_synthetic-click_ID";

function setup(href: string, referrer = "https://www.google.com/") {
  let state: AdConsentState = "unknown";
  let resolveLoad!: (command: GoogleCommand) => void;
  const command = vi.fn<GoogleCommand>();
  const load = vi.fn(
    () =>
      new Promise<GoogleCommand>((resolve) => {
        resolveLoad = resolve;
      }),
  );
  const leaveDocument = vi.fn();
  const page = { href, referrer };
  const controller = createGooglePublicController({
    href: () => page.href,
    referrer: () => page.referrer,
    consent: () => state,
    load,
    leaveDocument,
  });
  return {
    page,
    command,
    load,
    leaveDocument,
    controller,
    consent(next: AdConsentState) {
      state = next;
      controller.reconcile();
    },
    async loaded() {
      resolveLoad(command);
      await flush();
    },
    events: () => command.mock.calls.filter((call) => call[0] === "event"),
  };
}

describe("Google tag URL privacy contract", () => {
  it("accepts the ad landing with accented keywords and auto-tagging, on public pages only", () => {
    expect(safeGoogleUrl(adUrl)?.searchParams.get("utm_term")).toBe(
      "serviço de email transacional",
    );
    expect(safeGoogleUrl("https://mepmail.dev/pricing#planos")).toBeTruthy();
    expect(safeGoogleUrl("https://mepmail.dev/correio?gbraid=0AAAAA_synthetic")).toBeTruthy();
    for (const unsafe of [
      "https://mepmail.dev/mail",
      "https://mepmail.dev/dashboard?utm_source=google",
      "https://mepmail.dev/signup",
      "https://evil.invalid/?utm_source=google",
      "https://user:pass@mepmail.dev/",
      "https://mepmail.dev/?email=jean%40example.invalid",
      "https://mepmail.dev/?utm_term=session%20abc",
      "https://mepmail.dev/?utm_source=google&utm_source=bing",
      "https://mepmail.dev/?gclid=short",
      "https://mepmail.dev/?gad_campaignid=abc",
      `https://mepmail.dev/?utm_content=${"a".repeat(40)}`,
      "https://mepmail.dev/#private",
    ])
      expect(safeGoogleUrl(unsafe), unsafe).toBeNull();
  });
  it("lets the tag see only a public page or another site's bare origin as referrer", () => {
    expect(googleReferrer("")).toBe("");
    expect(googleReferrer("https://www.google.com/")).toBe("https://www.google.com/");
    expect(googleReferrer("https://mepmail.dev/pricing?utm_source=google")).toBe(
      "https://mepmail.dev/pricing",
    );
    for (const unsafe of [
      "https://mepmail.dev/mail",
      "https://mepmail.dev/dashboard",
      "https://www.google.com/search?q=private",
      "https://blog.invalid/post/42",
      "http://insecure.invalid/",
    ])
      expect(googleReferrer(unsafe), unsafe).toBeNull();
    expect(safeGoogleContext(adUrl, "https://mepmail.dev/mail")).toBe(false);
    expect(safeGoogleContext(adUrl, "https://www.google.com/")).toBe(true);
  });
});

describe("Google tag controller", () => {
  it("loads only after consent and sends one sanitized page view per public URL", async () => {
    const tag = setup(adUrl);
    tag.controller.reconcile();
    tag.consent("denied");
    expect(tag.load).not.toHaveBeenCalled();
    tag.consent("accepted");
    expect(tag.load).toHaveBeenCalledTimes(1);
    await tag.loaded();
    tag.controller.reconcile();
    expect(tag.command).toHaveBeenCalledWith(
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "granted", ad_personalization: "denied" }),
    );
    expect(tag.events()).toEqual([
      [
        "event",
        "page_view",
        {
          send_to: GOOGLE_TAG_ID,
          page_location: new URL(adUrl).href.replace(/#.*$/, ""),
          page_referrer: "https://www.google.com/",
        },
      ],
    ]);
    tag.page.href = "https://mepmail.dev/pricing";
    tag.controller.reconcile();
    expect(tag.events()).toHaveLength(2);
  });
  it("never loads on a private page, an unsafe referrer or without acceptance", () => {
    for (const [href, referrer, state] of [
      ["https://mepmail.dev/mail", "", "accepted"],
      [adUrl, "https://mepmail.dev/dashboard", "accepted"],
      [adUrl, "https://www.google.com/", "unknown"],
    ] as const) {
      const tag = setup(href, referrer);
      tag.consent(state);
      expect(tag.load, href).not.toHaveBeenCalled();
    }
  });
  it("a late tag load after withdrawal sends no grant or event", async () => {
    const tag = setup(adUrl);
    tag.consent("accepted");
    tag.consent("denied");
    await tag.loaded();
    expect(tag.events()).toEqual([]);
    const granted = tag.command.mock.calls.filter(
      (call) =>
        (call[2] as { analytics_storage?: string } | undefined)?.analytics_storage === "granted",
    );
    expect(granted).toEqual([]);
    expect(tag.command).toHaveBeenCalledWith(
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "denied", ad_storage: "denied" }),
    );
  });
  it("records the signup lead and leaves the document; private links only revoke and leave", async () => {
    const tag = setup(adUrl);
    tag.consent("accepted");
    await tag.loaded();
    expect(tag.controller.beforeNavigation("https://mepmail.dev/pricing")).toBe(false);
    expect(tag.controller.beforeNavigation("https://mepmail.dev/signup")).toBe(true);
    expect(tag.events().at(-1)).toEqual([
      "event",
      "generate_lead",
      { send_to: GOOGLE_TAG_ID, transport_type: "beacon" },
    ]);
    expect(tag.leaveDocument).toHaveBeenCalledWith("https://mepmail.dev/signup");
    const events = tag.events().length;
    expect(tag.controller.beforeNavigation("https://mepmail.dev/login")).toBe(true);
    expect(tag.events()).toHaveLength(events);
    expect(tag.command).toHaveBeenLastCalledWith(
      "consent",
      "update",
      expect.objectContaining({ analytics_storage: "denied" }),
    );
  });
  it("leaves navigation alone while the tag was never requested", () => {
    const tag = setup(adUrl);
    expect(tag.controller.beforeNavigation("https://mepmail.dev/signup")).toBe(false);
    expect(tag.leaveDocument).not.toHaveBeenCalled();
  });
});

describe("gtag.js loader (offline)", () => {
  it("queues denied defaults and a config without automatic page view before loading", async () => {
    const win = {} as Window;
    const script = {
      onload: () => {},
      onerror: () => {},
      src: "",
      referrerPolicy: "",
      async: false,
    };
    const doc = {
      createElement: () => script,
      head: { appendChild: vi.fn() },
    } as unknown as Document;
    const loaded = loadGoogleTag(win, doc);
    const layer = (win as unknown as { dataLayer: IArguments[] }).dataLayer.map((entry) => [
      ...entry,
    ]);
    expect(layer[0]).toEqual([
      "consent",
      "default",
      {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
    expect(layer).toContainEqual([
      "config",
      GOOGLE_TAG_ID,
      {
        send_page_view: false,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      },
    ]);
    expect(layer.some((entry) => entry[0] === "event")).toBe(false);
    expect(script.src).toBe(`https://www.googletagmanager.com/gtag/js?id=${GOOGLE_TAG_ID}`);
    expect(script.referrerPolicy).toBe("no-referrer");
    script.onload();
    await loaded;
    await expect(loadGoogleTag(win, doc)).rejects.toThrow("foreign_google_tag");
  });
});
