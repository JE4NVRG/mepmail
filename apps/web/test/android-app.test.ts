import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_APP_ATTRIBUTE,
  ANDROID_APP_HEADER,
  ANDROID_APP_HEADER_VALUE,
  ANDROID_APP_HELP,
  ANDROID_APP_INIT_SCRIPT,
  ANDROID_APP_STORAGE_KEY,
  androidAppHeaders,
  inAndroidApp,
  isAndroidAppRequest,
  isAndroidAppSalesPath,
  keepAndroidAppMark,
} from "@/lib/android-app";

/**
 * The Android app (TWA dev.mepmail.app): recognized before the first paint, it sells
 * nothing and measures nothing for advertising, while signing in, the mailboxes and the
 * account stay. Synthetic fixtures only.
 */

const billing = vi.hoisted(() => ({
  proof: null as unknown,
  recorded: vi.fn(),
  cancelRenewal: vi.fn(async () => ({ cancelAt: new Date("2026-11-14T00:00:00.000Z") })),
}));
vi.mock("@millionsend/billing", async (original) => ({
  ...(await original<typeof import("@millionsend/billing")>()),
  decodeConsentProof: () => billing.proof,
  recordSignupConversions: billing.recorded,
  cancelTeamRenewal: billing.cancelRenewal,
}));
// Authentication is synthetic in these router unit cases, as in billing-router.test.ts: the
// live membership row is covered by the operations integration tests.
vi.mock("@/server/request-membership", async () => import("./fixtures/legacy-router-membership"));
// The synthetic team reaches the Correio router: the gate under test is the Android one.
vi.mock("@/server/mailboxes", async (original) => ({
  ...(await original<typeof import("@/server/mailboxes")>()),
  mailboxActorAccessEnabled: async () => true,
}));

/** Runs the root layout's inline script against a fake tab. */
function launch(tab: {
  referrer?: string;
  search?: string;
  pathname?: string;
  stored?: string | null;
  storage?: "ok" | "throws";
}) {
  const store = new Map<string, string>();
  if (tab.stored) store.set(ANDROID_APP_STORAGE_KEY, tab.stored);
  const marks = new Set<string>();
  const replace = vi.fn();
  const assign = vi.fn();
  const listeners: Array<{ type: string; run: (event: unknown) => void; capture: unknown }> = [];
  const sessionStorage =
    tab.storage === "throws"
      ? {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
        }
      : {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => void store.set(key, value),
        };
  const run = new Function(
    "window",
    "document",
    "location",
    "URLSearchParams",
    ANDROID_APP_INIT_SCRIPT,
  );
  run(
    { sessionStorage },
    {
      referrer: tab.referrer ?? "",
      documentElement: { setAttribute: (name: string) => marks.add(name) },
      addEventListener: (type: string, run: (event: unknown) => void, capture: unknown) =>
        listeners.push({ type, run, capture }),
    },
    { search: tab.search ?? "", pathname: tab.pathname ?? "/mail", replace, assign },
    URLSearchParams,
  );
  /** A tap on a link to `href`, seen by the page's click listeners (capture phase). */
  const tap = (href: string | null) => {
    const anchor =
      href === null ? null : { hostname: new URL(href, "https://mepmail.dev").hostname };
    const event = { target: { closest: () => anchor }, preventDefault: vi.fn() };
    for (const listener of listeners) if (listener.type === "click") listener.run(event);
    return event;
  };
  return {
    stored: store.get(ANDROID_APP_STORAGE_KEY) ?? null,
    marked: marks.has(ANDROID_APP_ATTRIBUTE),
    replace,
    assign,
    listeners,
    tap,
  };
}

describe("Android app: recognized at the launch, before the first paint", () => {
  it("recognizes the TWA referrer and the start URL, and remembers it for the tab", () => {
    const byReferrer = launch({ referrer: "android-app://dev.mepmail.app/" });
    expect(byReferrer).toMatchObject({ stored: "1", marked: true });
    // The first draft package (internal test builds) is still the app.
    expect(launch({ referrer: "android-app://dev.mepmail.correio/" })).toMatchObject({
      stored: "1",
      marked: true,
    });
    expect(byReferrer.replace).not.toHaveBeenCalled();
    const byStartUrl = launch({ search: "?source=android" });
    expect(byStartUrl).toMatchObject({ stored: "1", marked: true });
    // Later pages of the same tab: no referrer, no query, still the app.
    expect(launch({ stored: "1", pathname: "/settings/billing" })).toMatchObject({ marked: true });
  });

  it("leaves the web alone: another referrer or app, no query, no mark", () => {
    for (const referrer of ["", "https://www.google.com/", "android-app://com.android.chrome/"]) {
      const tab = launch({ referrer, pathname: "/pricing" });
      expect(tab).toMatchObject({ stored: null, marked: false });
      expect(tab.replace).not.toHaveBeenCalled();
    }
    expect(launch({ search: "?source=web" })).toMatchObject({ marked: false });
  });

  it("opens the Correio instead of a public sales page, on a direct link too", () => {
    for (const pathname of ["/", "/pricing", "/pricing/", "/correio", "/alternatives/resend"]) {
      const tab = launch({ stored: "1", pathname });
      expect(tab.replace, pathname).toHaveBeenCalledWith("/mail");
    }
    // A direct link that is not a sales page stays: sign-in, the mailboxes, the account.
    for (const pathname of [
      "/mail",
      "/login",
      "/signup",
      "/settings",
      "/settings/billing",
      "/support",
    ]) {
      expect(launch({ stored: "1", pathname }).replace, pathname).not.toHaveBeenCalled();
    }
    // The launch itself on a sales page (a link opened in the app) also goes to the Correio.
    expect(
      launch({ referrer: "android-app://dev.mepmail.correio/", pathname: "/pricing" }).replace,
    ).toHaveBeenCalledWith("/mail");
  });

  it("opens the in-app help instead of the docs site, which lists the plans outside the app", () => {
    const app = launch({ stored: "1", pathname: "/mail" });
    expect(app.listeners).toMatchObject([{ type: "click", capture: true }]);
    for (const href of [
      "https://docs.mepmail.dev",
      "https://docs.mepmail.dev/pt-BR/mailboxes",
      "https://docs.mepmail.dev/billing#plans",
    ]) {
      app.assign.mockClear();
      const event = app.tap(href);
      expect(event.preventDefault, href).toHaveBeenCalled();
      expect(app.assign, href).toHaveBeenCalledWith(ANDROID_APP_HELP);
    }
    // Every other link, and a tap outside a link, goes on as usual.
    app.assign.mockClear();
    for (const href of [
      "/support#chat",
      "/mail/settings",
      "https://mepmail.dev/changelog",
      "https://github.com/JE4NVRG/mepmail",
      "mailto:suporte@mepmail.dev",
      null,
    ]) {
      expect(app.tap(href).preventDefault, String(href)).not.toHaveBeenCalled();
    }
    expect(app.assign).not.toHaveBeenCalled();
    // On the web the docs links stay links: no listener at all.
    expect(launch({ pathname: "/support" }).listeners).toEqual([]);
  });

  it("never breaks the page when storage is blocked", () => {
    expect(() => launch({ search: "?source=android", storage: "throws" })).not.toThrow();
  });

  it("names the sales paths for client-side navigations", () => {
    expect(isAndroidAppSalesPath("/pricing")).toBe(true);
    expect(isAndroidAppSalesPath("/envio")).toBe(true);
    expect(isAndroidAppSalesPath("/")).toBe(true);
    expect(isAndroidAppSalesPath("/mail")).toBe(false);
    expect(isAndroidAppSalesPath("/settings/billing")).toBe(false);
  });
});

describe("Android app: the requests say so", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks requests only inside the app", () => {
    vi.stubGlobal("document", { documentElement: { hasAttribute: () => false } });
    expect(inAndroidApp()).toBe(false);
    expect(androidAppHeaders()).toEqual({});
    vi.stubGlobal("document", {
      documentElement: { hasAttribute: (name: string) => name === ANDROID_APP_ATTRIBUTE },
    });
    expect(inAndroidApp()).toBe(true);
    expect(androidAppHeaders()).toEqual({ [ANDROID_APP_HEADER]: ANDROID_APP_HEADER_VALUE });
    const headers = new Headers(androidAppHeaders());
    expect(isAndroidAppRequest(headers)).toBe(true);
    expect(isAndroidAppRequest(new Headers({ [ANDROID_APP_HEADER]: "web" }))).toBe(false);
    expect(isAndroidAppRequest(null)).toBe(false);
  });

  it("stays the app when React cleared <html> after a hydration error, and puts the mark back", () => {
    const attributes = new Set<string>();
    const root = {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string) => void attributes.add(name),
    };
    vi.stubGlobal("document", { documentElement: root });
    // The web: no tab flag, no mark, nothing added.
    vi.stubGlobal("sessionStorage", { getItem: () => null });
    keepAndroidAppMark();
    expect(inAndroidApp()).toBe(false);
    expect(attributes.size).toBe(0);
    // The app after the reset: the tab flag is there, the mark is gone (seen on /mail, #418).
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => (key === ANDROID_APP_STORAGE_KEY ? "1" : null),
    });
    expect(inAndroidApp()).toBe(true);
    expect(androidAppHeaders()).toEqual({ [ANDROID_APP_HEADER]: ANDROID_APP_HEADER_VALUE });
    keepAndroidAppMark();
    expect(attributes.has(ANDROID_APP_ATTRIBUTE)).toBe(true);
    // Blocked storage is not the app.
    attributes.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(inAndroidApp()).toBe(false);
    keepAndroidAppMark();
    expect(attributes.size).toBe(0);
  });
});

const ANDROID_REFUSED = "Purchases are not available in the Android app.";

describe("Android app: nothing is sold there (server)", () => {
  let close: () => Promise<void>;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });
  afterEach(async () => {
    await close();
  });

  async function callers(teamId = "00000000-0000-4000-8000-000000000001", role = "owner") {
    const { createCallerFactory, router } = await import("@/server/trpc");
    const { createBillingRouter } = await import("@/server/routers/billing");
    const { mailboxesRouter } = await import("@/server/routers/mailboxes");
    const create = createCallerFactory(
      router({
        billing: createBillingRouter({ stripe: () => ({}) as never }),
        mailboxes: mailboxesRouter,
      }),
    );
    const base = {
      db,
      session: { user: { id: "u1", email: "u1@example.com", name: "u1" } },
      teamId,
      role,
    };
    return { app: create({ ...base, androidApp: true } as never), web: create(base as never) };
  }

  it("refuses every purchase or plan change from the app, whatever the input", async () => {
    const { app } = await callers();
    const attempts: Array<[string, () => Promise<unknown>]> = [
      [
        "billing.checkout",
        () => app.billing.checkout({ rung: "pro_100k", interval: "month" } as never),
      ],
      ["billing.pixCheckout", () => app.billing.pixCheckout({ rung: "pro_100k" } as never)],
      ["billing.changePlan", () => app.billing.changePlan({ rung: "pro_220k" } as never)],
      ["billing.payPixInvoice", () => app.billing.payPixInvoice({ invoiceId: "in_x" } as never)],
      ["billing.portal", () => app.billing.portal()],
      ["mailboxes.checkout", () => app.mailboxes.checkout({ seats: 1 } as never)],
      ["mailboxes.pixCheckout", () => app.mailboxes.pixCheckout({ offerId: "mbo_x" } as never)],
      ["mailboxes.changePlan", () => app.mailboxes.changePlan({ offerId: "mbo_x" } as never)],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Purchases are not available in the Android app.",
      });
    }
  });

  it("lets the app stop a renewal, which is not a purchase, under the normal owner/admin rule", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const teamId = await createTeam(db, "android-renewal");
    await db
      .update(schema.teams)
      .set({
        plan: "pro",
        planQuota: 110_000,
        planStatus: "active",
        stripeCustomerId: "cus_android_test",
        stripeSubscriptionId: "sub_android_test",
      })
      .where(eq(schema.teams.id, teamId));
    billing.cancelRenewal.mockClear();
    const owner = await callers(teamId, "owner");
    const operationId = "6f1d5b3a-2c4e-4f8a-9b7c-1d2e3f4a5b6c";
    await expect(owner.app.billing.cancelRenewal({ operationId })).resolves.toEqual({
      cancelAt: new Date("2026-11-14T00:00:00.000Z"),
    });
    expect(billing.cancelRenewal).toHaveBeenCalledWith(expect.anything(), teamId, operationId);
    // A member cannot, on the app or the web: the same rule as every billing change.
    const member = await callers(teamId, "member");
    await expect(member.app.billing.cancelRenewal({ operationId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(billing.cancelRenewal).toHaveBeenCalledTimes(1);
    // Stripe's current state still renews (a replayed answer, say): no success is reported.
    const { RenewalCancelError } = await import("@millionsend/billing");
    billing.cancelRenewal.mockRejectedValueOnce(new RenewalCancelError());
    await expect(
      owner.app.billing.cancelRenewal({ operationId: "0b8e2f3c-5d6a-4b7c-8d9e-0f1a2b3c4d5e" }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "renewal_not_cancelled" });
    // The Correio license: the app may only cancel the renewal; resuming it, changing the
    // quantity or reconciling it are purchases and stay on the web.
    for (const action of ["resume", "quantity", "reconcile"] as const) {
      await expect(
        owner.app.mailboxes.manage({ action, ...(action === "quantity" ? { seats: 2 } : {}) }),
        action,
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: ANDROID_REFUSED });
    }
    const cancel = await owner.app.mailboxes
      .manage({ action: "cancel" })
      .catch((cause: unknown) => cause as { message?: string });
    expect((cancel as { message?: string })?.message).not.toBe(ANDROID_REFUSED);
    vi.unstubAllEnvs();
  });

  it("does not refuse the same calls on the web for being the app", async () => {
    const { web } = await callers();
    const error = await web.billing
      .portal()
      .catch((cause: unknown) => cause as { message?: string });
    expect((error as { message?: string })?.message).not.toBe(
      "Purchases are not available in the Android app.",
    );
  });
});

describe("Android app: no advertising conversion for a sign-up made in it", () => {
  beforeEach(() => {
    billing.recorded.mockClear();
    billing.proof = { granted: true, policyVersion: "ads-v2" };
  });

  it("skips the conversion when the sign-up came from the app, even with an accepted consent cookie", async () => {
    const { recordSignupAdvertising } = await import("@/server/signup-advertising");
    await recordSignupAdvertising(
      {} as never,
      "u1",
      new Headers({ cookie: "mm_ad=1", [ANDROID_APP_HEADER]: ANDROID_APP_HEADER_VALUE }),
    );
    expect(billing.recorded).not.toHaveBeenCalled();
    // The same request from the web records it (the consent was accepted there).
    await recordSignupAdvertising({} as never, "u1", new Headers({ cookie: "mm_ad=1" }));
    expect(billing.recorded).toHaveBeenCalledTimes(1);
  });
});
