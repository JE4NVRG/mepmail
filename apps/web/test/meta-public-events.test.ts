import { describe, expect, it, vi } from "vitest";
import { AD_POLICY_VERSION, type AdConsentState, createAdConsentStore } from "@/lib/ad-consent";
import {
  createMetaPublicController,
  guardMetaNavigation,
  loadManualMetaSdk,
  META_PIXEL_ID,
  type MetaCommand,
  safeMetaContext,
  safeMetaUrl,
} from "@/lib/meta-public-events";

const receipt = (state: AdConsentState, policyVersion = AD_POLICY_VERSION) =>
  new Response(JSON.stringify({ state, policyVersion }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("server advertising consent", () => {
  it("starts denied in effect, reads without creating proof, validates policy", async () => {
    const request = vi.fn().mockResolvedValue(receipt("accepted"));
    const store = createAdConsentStore(request);
    expect(store.getSnapshot().state).toBe("unknown");
    await store.read();
    expect(store.getSnapshot().state).toBe("accepted");
    expect(request).toHaveBeenCalledWith("/api/advertising-consent", {
      credentials: "same-origin",
      cache: "no-store",
    });
    request.mockResolvedValue(
      new Response(JSON.stringify({ state: "accepted", policyVersion: "old" })),
    );
    await store.read();
    expect(store.getSnapshot()).toMatchObject({ state: "unknown", error: true });
  });
  it("never activates while acceptance is pending or failed", async () => {
    const pending = deferred<Response>();
    const store = createAdConsentStore(vi.fn().mockReturnValue(pending.promise));
    const choice = store.choose(true);
    expect(store.getSnapshot()).toMatchObject({ state: "unknown", pending: true });
    pending.resolve(new Response("", { status: 503 }));
    await choice;
    expect(store.getSnapshot()).toMatchObject({ state: "denied", error: true });
  });
  it("serializes accept then withdrawal and ignores the stale accepted response", async () => {
    const accepted = deferred<Response>();
    const request = vi
      .fn()
      .mockReturnValueOnce(accepted.promise)
      .mockResolvedValueOnce(receipt("denied"));
    const store = createAdConsentStore(request);
    const accept = store.choose(true);
    await flush();
    const deny = store.choose(false);
    expect(store.getSnapshot().state).toBe("denied");
    expect(request).toHaveBeenCalledTimes(1);
    accepted.resolve(receipt("accepted"));
    await accept;
    await deny;
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[1]?.[1].body ?? "null")).toEqual({
      granted: false,
      policyVersion: AD_POLICY_VERSION,
    });
    expect(store.getSnapshot()).toEqual({ state: "denied", pending: false, error: false });
  });
  it("withdrawal invalidates a pending GET and stays blocked on server failure", async () => {
    const reading = deferred<Response>();
    const request = vi
      .fn()
      .mockReturnValueOnce(reading.promise)
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    const store = createAdConsentStore(request);
    const read = store.read();
    await store.choose(false);
    reading.resolve(receipt("accepted"));
    await read;
    expect(store.getSnapshot()).toMatchObject({ state: "denied", error: true });
  });
  it("a later authoritative read cannot undo a failed/local withdrawal", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockImplementation(() => Promise.resolve(receipt("accepted")));
    const store = createAdConsentStore(request);
    await store.choose(false);
    await store.read();
    expect(store.getSnapshot()).toMatchObject({ state: "denied", error: true });
    // An explicit, successful new acceptance is required to remove the local block.
    await store.choose(true);
    expect(store.getSnapshot()).toMatchObject({ state: "accepted", error: false });
    store.blockLocally();
    await store.read();
    expect(store.getSnapshot()).toMatchObject({ state: "denied", error: true });
  });
  it("does not read an old cookie while a denial is being persisted", async () => {
    const pending = deferred<Response>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const store = createAdConsentStore(request);
    const choice = store.choose(false);
    await flush();
    const read = store.read();
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(receipt("denied"));
    await choice;
    await read;
    expect(store.getSnapshot().state).toBe("denied");
  });
});

describe("public URL privacy contract", () => {
  it("allows direct/public visits and bounded campaign identifiers", () => {
    expect(
      safeMetaContext(
        "https://mepmail.dev/?utm_source=facebook&utm_campaign=send-pro&fbclid=IwAR_1234567890",
        "https://www.facebook.com/",
      ),
    ).toBe(true);
    expect(safeMetaContext("https://mepmail.dev/pricing#planos", "https://mepmail.dev/")).toBe(
      true,
    );
  });
  it.each([
    "http://mepmail.dev/",
    "https://www.mepmail.dev/",
    "http://localhost:3000/",
    "https://mepmail.dev/dashboard",
    "https://mepmail.dev/signup",
    "https://mepmail.dev/mailboxes",
    "https://mepmail.dev/?email=person@example.com",
    "https://mepmail.dev/?utm_campaign=person%40example.com",
    "https://mepmail.dev/?utm_source=a&utm_source=b",
    "https://mepmail.dev/?utm_term=secret-token",
    "https://mepmail.dev/?fbclid=short",
    "https://mepmail.dev/#private-token",
  ])("rejects unsafe document %s", (url) => {
    expect(safeMetaUrl(url)).toBeNull();
  });
  it.each([
    "https://mepmail.dev/dashboard",
    "https://mepmail.dev/login?token=hidden",
    "https://example.com/",
    "https://www.facebook.com/private/path",
    "https://www.facebook.com/?email=hidden",
  ])("rejects unsafe referrer %s", (referrer) => {
    expect(safeMetaContext("https://mepmail.dev/", referrer)).toBe(false);
  });
});

function setup(href = "https://mepmail.dev/") {
  let state: AdConsentState = "unknown";
  let location = href;
  const command = vi.fn();
  const loader = deferred<MetaCommand>();
  const load = vi.fn(() => loader.promise);
  const stop = vi.fn();
  let viewport: (() => void) | undefined;
  const leave = vi.fn();
  const controller = createMetaPublicController({
    href: () => location,
    referrer: () => "",
    consent: () => state,
    load,
    watchPlans: (callback) => {
      viewport = callback;
      return stop;
    },
    leaveDocument: leave,
  });
  return {
    controller,
    command,
    loader,
    load,
    leave,
    stop,
    consent: (next: AdConsentState) => {
      state = next;
      controller.reconcile();
    },
    navigate: (next: string) => {
      location = next;
      controller.reconcile();
    },
    viewport: () => viewport?.(),
  };
}

describe("manual public Pixel controller", () => {
  it("does not load on denied/unknown/private context", () => {
    const publicPage = setup();
    publicPage.controller.reconcile();
    publicPage.consent("denied");
    expect(publicPage.load).not.toHaveBeenCalled();
    const privatePage = setup("https://mepmail.dev/dashboard");
    privatePage.consent("accepted");
    expect(privatePage.load).not.toHaveBeenCalled();
  });
  it("deduplicates hydration and observer callbacks, with no checkout/payment calls", async () => {
    const page = setup();
    page.consent("accepted");
    page.controller.reconcile();
    expect(page.load).toHaveBeenCalledTimes(1);
    page.loader.resolve(page.command);
    await flush();
    page.controller.reconcile();
    page.viewport();
    page.viewport();
    const events = page.command.mock.calls.filter((call) => call[0] === "trackSingle");
    expect(events.map((call) => call[2])).toEqual(["PageView", "ViewContent"]);
    expect(events[1]?.[3]).toEqual({
      content_ids: ["send-pro"],
      content_name: "MepMail Send Pro",
      content_type: "product",
    });
    page.navigate("https://mepmail.dev/pricing");
    page.controller.reconcile();
    expect(
      page.command.mock.calls.filter((call) => call[0] === "trackSingle").map((call) => call[2]),
    ).toEqual(["PageView", "ViewContent", "PageView", "ViewContent"]);
  });
  it("late SDK completion after withdrawal sends no grant/event", async () => {
    const page = setup("https://mepmail.dev/pricing");
    page.consent("accepted");
    page.consent("denied");
    page.loader.resolve(page.command);
    await flush();
    expect(page.command.mock.calls).toEqual([["consent", "revoke"]]);
  });
  it("withdrawal stops observers immediately and suppresses later callback events", async () => {
    const page = setup();
    page.consent("accepted");
    page.loader.resolve(page.command);
    await flush();
    page.consent("denied");
    page.viewport();
    expect(page.stop).toHaveBeenCalledTimes(1);
    expect(page.command.mock.calls.filter((call) => call[0] === "trackSingle")).toHaveLength(1);
    expect(page.command).toHaveBeenLastCalledWith("consent", "revoke");
  });
  it("forces a new document before private/unknown-query navigation, even during load", () => {
    const page = setup();
    expect(page.controller.beforeNavigation("https://mepmail.dev/dashboard")).toBe(false);
    page.consent("accepted");
    expect(
      page.controller.beforeNavigation("https://mepmail.dev/pricing?utm_source=facebook"),
    ).toBe(false);
    expect(page.controller.beforeNavigation("https://mepmail.dev/dashboard")).toBe(true);
    expect(page.leave).toHaveBeenCalledWith("https://mepmail.dev/dashboard");
    expect(page.controller.beforeNavigation("https://mepmail.dev/?email=private")).toBe(true);
  });
});

describe("manual SDK and navigation wiring (offline)", () => {
  it("queues only revoke/config/init, no matching or events before successful load", async () => {
    const win = {} as Window;
    const script = { onload: () => {}, src: "", referrerPolicy: "" };
    const doc = {
      createElement: () => script,
      head: { appendChild: vi.fn() },
    } as unknown as Document;
    const loaded = loadManualMetaSdk(win, doc);
    const fbq = (win as unknown as { fbq: { queue: unknown[][]; disablePushState: boolean } }).fbq;
    expect(fbq.disablePushState).toBe(true);
    expect(fbq.queue).toEqual([
      ["consent", "revoke"],
      ["set", "autoConfig", false, META_PIXEL_ID],
      ["init", META_PIXEL_ID],
    ]);
    expect(script.src).toBe("https://connect.facebook.net/en_US/fbevents.js");
    expect(script.referrerPolicy).toBe("no-referrer");
    (fbq as unknown as { callMethod: MetaCommand }).callMethod = vi.fn();
    script.onload();
    await loaded;
    await expect(loadManualMetaSdk(win, doc)).rejects.toThrow("foreign_meta_sdk");
  });
  it("an SDK without its command implementation fails closed", async () => {
    const win = {} as Window;
    const script = { onload: () => {} };
    const doc = {
      createElement: () => script,
      head: { appendChild: vi.fn() },
    } as unknown as Document;
    const loaded = loadManualMetaSdk(win, doc);
    script.onload();
    await expect(loaded).rejects.toThrow("meta_sdk_unavailable");
  });
  it("captures a same-origin private Link anchor before its client handler", () => {
    class Anchor {
      href = "https://mepmail.dev/dashboard";
      target = "";
      closest() {
        return this;
      }
      hasAttribute() {
        return false;
      }
    }
    vi.stubGlobal("Element", Anchor);
    vi.stubGlobal("HTMLAnchorElement", Anchor);
    try {
      let capture: ((event: MouseEvent) => void) | undefined;
      const win = {
        location: { href: "https://mepmail.dev/", origin: "https://mepmail.dev" },
        history: { pushState: vi.fn(), replaceState: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const doc = {
        addEventListener: (name: string, callback: (event: MouseEvent) => void) => {
          if (name === "click") capture = callback;
        },
        removeEventListener: vi.fn(),
      };
      const beforeNavigation = vi.fn(() => true);
      const restore = guardMetaNavigation(win as unknown as Window, doc as unknown as Document, {
        beforeNavigation,
        reconcile: vi.fn(),
        dispose: vi.fn(),
      });
      const event = {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: new Anchor(),
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      };
      capture?.(event as unknown as MouseEvent);
      expect(beforeNavigation).toHaveBeenCalledWith("https://mepmail.dev/dashboard");
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      restore();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("captures private history and popstate, restores only its owned methods", () => {
    const callbacks = new Map<string, () => void>();
    const beforeNavigation = vi.fn((href: string) => href.includes("dashboard"));
    const reconcile = vi.fn();
    const push = vi.fn<History["pushState"]>(),
      replace = vi.fn<History["replaceState"]>();
    const win = {
      location: { href: "https://mepmail.dev/", origin: "https://mepmail.dev" },
      history: { pushState: push, replaceState: replace },
      addEventListener: (name: string, callback: () => void) => callbacks.set(name, callback),
      removeEventListener: vi.fn(),
    };
    const doc = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const restore = guardMetaNavigation(win as unknown as Window, doc as unknown as Document, {
      beforeNavigation,
      reconcile,
      dispose: vi.fn(),
    });
    win.history.pushState({}, "", "/dashboard");
    expect(push).not.toHaveBeenCalled();
    win.history.replaceState({}, "", "/pricing");
    expect(replace).toHaveBeenCalledTimes(1);
    win.location.href = "https://mepmail.dev/dashboard";
    callbacks.get("popstate")?.();
    expect(beforeNavigation).toHaveBeenLastCalledWith("https://mepmail.dev/dashboard");
    restore();
    expect(win.history.pushState).toBe(push);
    expect(win.history.replaceState).toBe(replace);
    expect(doc.addEventListener).toHaveBeenCalledWith("click", expect.any(Function), true);
  });
});
