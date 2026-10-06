import type { DependencyList, EffectCallback, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AD_POLICY_VERSION, createAdConsentStore } from "@/lib/ad-consent";

type ConsentStore = ReturnType<typeof createAdConsentStore>;
type Effect = { dependencies: DependencyList | undefined; cleanup: (() => void) | undefined };
const fixture = vi.hoisted(() => ({
  pathname: "/signup",
  store: {} as ConsentStore,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Effect[],
  jobs: [] as Array<() => void>,
  stateCursor: 0,
  refCursor: 0,
  effectCursor: 0,
  sdk: vi.fn(),
  command: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => fixture.pathname }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("react/jsx-dev-runtime", async () => {
  // The component's production flag is real; Vitest still transforms JSX with jsxDEV.
  const runtime = await import("react/jsx-runtime");
  return { ...runtime, jsxDEV: runtime.jsx };
});
vi.mock("@/lib/ad-consent", async (original) => {
  const real = await original<typeof import("@/lib/ad-consent")>();
  return {
    ...real,
    // Dispatch to the real per-document store, retaining its authority/race protection.
    adConsent: {
      getSnapshot: () => fixture.store.getSnapshot(),
      getServerSnapshot: () => fixture.store.getServerSnapshot(),
      subscribe: (callback: () => void) => fixture.store.subscribe(callback),
      read: () => fixture.store.read(),
      choose: (granted: boolean) => fixture.store.choose(granted),
      blockLocally: () => fixture.store.blockLocally(),
    },
  };
});
vi.mock("@/lib/meta-public-events", async (original) => {
  const real = await original<typeof import("@/lib/meta-public-events")>();
  return { ...real, loadManualMetaSdk: fixture.sdk };
});
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return {
    ...real,
    // SSR does not commit passive effects. These deterministic hook slots exercise
    // the actual component's route effects without pretending to be browser hydration.
    useEffect: (callback: EffectCallback, dependencies?: DependencyList) => {
      const index = fixture.effectCursor++;
      const previous = fixture.effects[index];
      const changed =
        !previous ||
        !dependencies ||
        !previous.dependencies ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((value, slot) => !Object.is(value, previous.dependencies?.[slot]));
      if (changed) {
        fixture.jobs.push(() => {
          previous?.cleanup?.();
          const cleanup = callback();
          fixture.effects[index] = {
            dependencies,
            cleanup: typeof cleanup === "function" ? cleanup : undefined,
          };
        });
      }
    },
    useState: (initial: unknown) => {
      const index = fixture.stateCursor++;
      if (!(index in fixture.states)) {
        fixture.states[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        fixture.states[index],
        (value: unknown) => {
          fixture.states[index] =
            typeof value === "function" ? value(fixture.states[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = fixture.refCursor++;
      fixture.refs[index] ??= { current: initial };
      return fixture.refs[index];
    },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

const location = {
  href: "https://mepmail.dev/signup",
  origin: "https://mepmail.dev",
  assign: vi.fn(),
};
const documentFixture = {
  referrer: "",
  visibilityState: "visible",
  getElementById: () => null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
const request = vi.fn<typeof fetch>();
let Component: () => ReactElement | null;
let tree: ReactElement | null;

const receipt = (state: "accepted" | "denied" | "unknown", policyVersion = AD_POLICY_VERSION) =>
  new Response(JSON.stringify({ state, policyVersion }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function paint() {
  fixture.stateCursor = fixture.refCursor = fixture.effectCursor = 0;
  tree = Component();
  const html = renderToStaticMarkup(tree);
  for (const job of fixture.jobs.splice(0)) job();
  return html;
}
function navigate(href: string) {
  const url = new URL(href, "https://mepmail.dev");
  location.href = url.href;
  location.origin = url.origin;
  fixture.pathname = url.pathname;
  return paint();
}
function events() {
  return fixture.command.mock.calls.filter((call) => call[0] === "trackSingle");
}
function findButton(label: string, node: unknown): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = findButton(label, child);
      if (result) return result;
    }
  } else if (node && typeof node === "object" && "props" in node) {
    const element = node as ReactElement<{ children?: unknown; onClick?: () => void }>;
    if (element.type === "button" && element.props.children === label) return element.props.onClick;
    return findButton(label, element.props.children);
  }
  return undefined;
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ID", "1418150576403119");
  fixture.pathname = "/signup";
  fixture.states = [];
  fixture.refs = [];
  fixture.effects = [];
  fixture.jobs = [];
  fixture.sdk.mockReset().mockResolvedValue(fixture.command);
  fixture.command.mockReset();
  request.mockReset().mockResolvedValue(receipt("accepted"));
  fixture.store = createAdConsentStore(request);
  location.href = "https://mepmail.dev/signup";
  location.origin = "https://mepmail.dev";
  location.assign.mockReset();
  documentFixture.referrer = "";
  vi.stubGlobal("window", {
    location,
    history: { pushState: vi.fn(), replaceState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", documentFixture);
  vi.stubGlobal("BroadcastChannel", undefined);
  Component = (await import("@/components/advertising-consent")).AdvertisingConsent;
});
afterEach(() => {
  for (const effect of fixture.effects.toReversed()) effect.cleanup?.();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("persisted consent after a private document reload and internal return", () => {
  it.each(["/", "/pricing"])("rereads accepted server consent on return to %s", async (path) => {
    paint();
    expect(request).not.toHaveBeenCalled();
    expect(fixture.sdk).not.toHaveBeenCalled();
    navigate(
      `${path}?campaign_id=120250209898050789&adset_id=120250209898060789&ad_id=120250210010930789`,
    );
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("accepted"));
    expect(paint()).toContain('data-state="accepted"');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/advertising-consent", {
      credentials: "same-origin",
      cache: "no-store",
    });
    await vi.waitFor(() => expect(fixture.sdk).toHaveBeenCalledTimes(1));
    expect(events().map((call) => call[2])).toEqual(
      path === "/" ? ["PageView"] : ["PageView", "ViewContent"],
    );
  });
  it("restores the preference without loading the SDK when the original referrer is private", async () => {
    documentFixture.referrer = "https://mepmail.dev/signup";
    paint();
    navigate("/");
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("accepted"));
    expect(paint()).toContain('data-state="accepted"');
    expect(fixture.sdk).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
  it("retains a persisted refusal rather than treating the public route as acceptance", async () => {
    request.mockResolvedValue(receipt("denied"));
    paint();
    navigate("/");
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("denied"));
    expect(paint()).toContain('data-state="denied"');
    expect(fixture.sdk).not.toHaveBeenCalled();
  });
  it("coalesces the mount and pathname reads on a public first load", async () => {
    navigate("/");
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("accepted"));
    paint();
    expect(request).toHaveBeenCalledTimes(1);
    expect(fixture.sdk).toHaveBeenCalledTimes(1);
    expect(events().map((call) => call[2])).toEqual(["PageView"]);
  });
  it("does not load on a private route if the public read completes after leaving", async () => {
    const pending = deferred<Response>();
    request.mockReturnValue(pending.promise);
    paint();
    navigate("/");
    expect(fixture.sdk).not.toHaveBeenCalled();
    navigate("/signup");
    pending.resolve(receipt("accepted"));
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("accepted"));
    expect(fixture.sdk).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
  it("a real refusal control wins over a stale accepted server read", async () => {
    const pending = deferred<Response>();
    request.mockImplementation((_input, init) =>
      init?.method === "POST" ? Promise.resolve(receipt("denied")) : pending.promise,
    );
    paint();
    navigate("/");
    paint();
    const deny = findButton("deny", tree);
    expect(deny).toBeDefined();
    deny?.();
    await vi.waitFor(() =>
      expect(fixture.store.getSnapshot()).toMatchObject({ state: "denied", pending: false }),
    );
    pending.resolve(receipt("accepted"));
    await fixture.store.read();
    expect(fixture.store.getSnapshot()).toMatchObject({ state: "denied", error: false });
    expect(fixture.sdk).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
  it("an explicit withdrawal stays denied on public return and revokes further events", async () => {
    let persisted: "accepted" | "denied" = "accepted";
    request.mockImplementation((_input, init) => {
      if (init?.method === "POST") persisted = "denied";
      return Promise.resolve(receipt(persisted));
    });
    paint();
    navigate("/");
    await vi.waitFor(() => expect(fixture.sdk).toHaveBeenCalledTimes(1));
    paint();
    const withdraw = findButton("withdraw", tree);
    expect(withdraw).toBeDefined();
    withdraw?.();
    await vi.waitFor(() =>
      expect(fixture.store.getSnapshot()).toMatchObject({ state: "denied", pending: false }),
    );
    expect(fixture.command).toHaveBeenLastCalledWith("consent", "revoke");
    navigate("/signup");
    navigate("/pricing");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    expect(fixture.store.getSnapshot().state).toBe("denied");
    expect(fixture.sdk).toHaveBeenCalledTimes(1);
    expect(events().map((call) => call[2])).toEqual(["PageView"]);
  });
  it("public reentry cannot undo a local withdrawal even if the server still says accepted", async () => {
    paint();
    fixture.store.blockLocally();
    navigate("/");
    await vi.waitFor(() =>
      expect(fixture.store.getSnapshot()).toMatchObject({ state: "denied", error: true }),
    );
    expect(paint()).toContain('data-state="error"');
    expect(fixture.sdk).not.toHaveBeenCalled();
  });
  it.each(["/login", "/mailboxes", "/settings"])(
    "does not restore/load merely by visiting private %s",
    (path) => {
      paint();
      navigate(path);
      expect(request).not.toHaveBeenCalled();
      expect(fixture.sdk).not.toHaveBeenCalled();
    },
  );
  it("fails closed when the persisted preference cannot be read", async () => {
    request.mockResolvedValue(new Response("", { status: 503 }));
    paint();
    navigate("/");
    await vi.waitFor(() =>
      expect(fixture.store.getSnapshot()).toMatchObject({ state: "unknown", error: true }),
    );
    expect(paint()).toContain('data-state="error"');
    expect(fixture.sdk).not.toHaveBeenCalled();
  });
  it("never activates a public URL with unknown sensitive query data", async () => {
    paint();
    navigate("/?campaign_id=120250209898050789&email=person%40example.com");
    await vi.waitFor(() => expect(fixture.store.getSnapshot().state).toBe("accepted"));
    expect(fixture.sdk).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
  });
  it("does not read or load when public advertising is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_META_PIXEL_ENABLED", "false");
    vi.resetModules();
    Component = (await import("@/components/advertising-consent")).AdvertisingConsent;
    paint();
    navigate("/");
    expect(request).not.toHaveBeenCalled();
    expect(fixture.sdk).not.toHaveBeenCalled();
  });
});
