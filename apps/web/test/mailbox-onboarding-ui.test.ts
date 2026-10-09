import { readFileSync } from "node:fs";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement, type FormEvent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes.json";
import enService from "../messages/en/mailboxes-service.json";
import pt from "../messages/pt-BR/mailboxes.json";
import ptService from "../messages/pt-BR/mailboxes-service.json";
import {
  MailboxServicePanel,
  mailboxCheckoutFailure,
  mailboxServiceNotice,
} from "../src/app/(dashboard)/mailboxes/mailbox-service-panel";
import { MailboxSetupDialog } from "../src/app/(dashboard)/mailboxes/mailbox-setup-dialog";

const fixture = vi.hoisted(() => ({
  mode: "setup" as "setup" | "panel",
  stateCursor: 0,
  // Seed later wizard screens for SSR; browser navigation/focus is qualified separately.
  seeds: {} as Record<number, unknown>,
  queries: [] as Array<Record<string, unknown>>,
  service: {} as ReturnType<typeof querySnapshot>,
  receiving: {} as ReturnType<typeof querySnapshot>,
  billing: {} as ReturnType<typeof querySnapshot>,
  buttons: [] as Array<Record<string, unknown>>,
  controls: [] as Array<Record<string, unknown>>,
  forms: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  checkout: vi.fn(),
  manage: vi.fn(),
  invalidate: vi.fn(),
  receivingRefetch: vi.fn(),
  serviceRefetch: vi.fn(),
  pendingCreate: false,
  initialOfferId: null as string | null,
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = fixture.stateCursor++;
      const seed = Object.hasOwn(fixture.seeds, index)
        ? fixture.seeds[index]
        : fixture.mode === "panel" && index === 0
          ? true
          : initial;
      const [state] = react.useState(seed);
      return [
        state,
        (next: unknown) => {
          fixture.seeds[index] =
            typeof next === "function" ? (next as (old: unknown) => unknown)(state) : next;
        },
      ];
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: Record<string, unknown>) => {
    fixture.queries.push(query);
    if (query.kind === "service") return fixture.service;
    if (query.kind === "receiving") return fixture.receiving;
    if (query.kind === "billing") return fixture.billing;
    // The MX guide is public-DNS only; with no answer yet it renders nothing.
    if (query.kind === "receivingGuide") return { data: undefined, isFetching: false };
    throw new Error("Unexpected onboarding query");
  },
  useMutation: (options: { kind: string }) => ({
    isPending: options.kind === "create" && fixture.pendingCreate,
    mutateAsync:
      options.kind === "create"
        ? fixture.create
        : options.kind === "checkout"
          ? fixture.checkout
          : fixture.manage,
  }),
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    mailboxes: Object.fromEntries(
      [
        "service",
        "receiving",
        "receivingGuide",
        "billing",
        "create",
        "checkout",
        "manage",
        "verifyReceiving",
      ].map((kind) => [
        kind,
        {
          queryOptions: (input: unknown, options: Record<string, unknown>) => ({
            kind,
            input,
            ...options,
          }),
          queryKey: () => ["mailboxes", kind],
          mutationOptions: () => ({ kind }),
        },
      ]),
    ),
  }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));
vi.mock("react/jsx-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: Record<string, unknown>) => {
    if (type === "button") fixture.buttons.push(props);
    if (type === "input" || type === "select") fixture.controls.push(props);
    if (type === "form") fixture.forms.push(props);
  };
  return {
    ...runtime,
    jsx: (type: Parameters<typeof runtime.jsx>[0], props: Record<string, unknown>, key: string) => {
      capture(type, props);
      return runtime.jsx(type, props, key);
    },
    jsxs: (
      type: Parameters<typeof runtime.jsxs>[0],
      props: Record<string, unknown>,
      key: string,
    ) => {
      capture(type, props);
      return runtime.jsxs(type, props, key);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = args;
      if (type === "button") fixture.buttons.push(props as Record<string, unknown>);
      if (type === "input" || type === "select")
        fixture.controls.push(props as Record<string, unknown>);
      if (type === "form") fixture.forms.push(props as Record<string, unknown>);
      return runtime.jsxDEV(...args);
    },
  };
});

const instant = new Date("2026-10-05T12:00:00Z");
const owner = { id: "synthetic-owner", name: "Synthetic owner", email: "owner@synthetic.invalid" };
const pendingDomain = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "pending.synthetic.invalid",
  status: "pending" as const,
};
const verifiedDomain = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "verified.synthetic.invalid",
  status: "verified" as const,
};
const options: Parameters<typeof MailboxSetupDialog>[0]["options"] = {
  domains: [pendingDomain, verifiedDomain],
  members: [owner],
  currentUserId: owner.id,
};
const close = vi.fn();
const changed = vi.fn();
const reviewLicense = vi.fn();
function querySnapshot(data?: Record<string, unknown>) {
  return {
    data,
    isPending: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: instant.getTime(),
    refetch: vi.fn(),
  };
}
function service(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    licenseKind: "system",
    unlimitedSeats: true,
    resourcePolicyActive: true,
    status: "active",
    seats: 2,
    reservedSeats: 5,
    storageBytesPerMailbox: 1024 ** 3,
    includedOutboundPerMailbox: 100,
    periodStart: new Date("2026-10-04T00:00:00Z"),
    periodEnd: new Date("2026-11-03T00:00:00Z"),
    cancelAtPeriodEnd: false,
    cancelAt: null,
    ...overrides,
  };
}
function billing(overrides: Record<string, unknown> = {}) {
  return {
    availability: "unavailable",
    canPurchase: false,
    canManage: false,
    sendingPlanRequired: false,
    pendingCheckoutSeats: null,
    checkoutPending: false,
    offer: null,
    offers: [],
    defaultOfferId: null,
    pendingOfferId: null,
    pendingOffer: null,
    management: {
      canReconcile: false,
      canAdjust: false,
      canIncrease: false,
      canCancel: false,
      canResume: false,
      pending: false,
      scheduledSeats: null,
      requestedSeats: null,
      effectiveAt: null,
    },
    ...overrides,
  };
}
const oneOffer = {
  offerId: "synthetic-one",
  currency: "usd",
  unitAmount: 1250,
  interval: "month",
  storageBytesPerMailbox: 1024 ** 3,
  includedOutboundPerMailbox: 500,
};
const tenOffer = {
  ...oneOffer,
  offerId: "synthetic-ten",
  unitAmount: 3750,
  storageBytesPerMailbox: 10 * 1024 ** 3,
  includedOutboundPerMailbox: 2000,
};
function purchasable(overrides: Record<string, unknown> = {}) {
  fixture.service.data = service({
    active: false,
    licenseKind: "none",
    unlimitedSeats: false,
    resourcePolicyActive: false,
    seats: 0,
    reservedSeats: 0,
    storageBytesPerMailbox: 0,
    includedOutboundPerMailbox: 0,
  });
  fixture.billing.data = billing({
    canPurchase: true,
    availability: "available",
    offers: [oneOffer, tenOffer],
    offer: oneOffer,
    defaultOfferId: oneOffer.offerId,
    ...overrides,
  });
}
const messages = {
  en: { mailboxes: en, "mailboxes-service": enService },
  "pt-BR": { mailboxes: pt, "mailboxes-service": ptService },
};
type Locale = keyof typeof messages;
function translate(locale: Locale) {
  return createTranslator({ locale, messages: messages[locale], namespace: "mailboxes.setup" });
}
function plain(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function render(locale: Locale, setupOptions = options) {
  fixture.stateCursor = 0;
  fixture.buttons = [];
  fixture.controls = [];
  fixture.forms = [];
  fixture.queries = [];
  const child =
    fixture.mode === "setup"
      ? createElement(MailboxSetupDialog, { options: setupOptions, close, changed, reviewLicense })
      : createElement<NonNullable<Parameters<typeof MailboxServicePanel>[0]>>(MailboxServicePanel, {
          initialOfferId: fixture.initialOfferId,
        });
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messages[locale],
      now: instant,
      timeZone: "UTC",
      // biome-ignore lint/correctness/noChildrenProp: NextIntlClientProvider requires a typed children property with createElement.
      children: child,
    }),
  );
}
function click(label: string) {
  const button = fixture.buttons.find(
    (props) =>
      plain(renderToStaticMarkup(createElement("span", null, props.children as ReactNode))) ===
      label,
  );
  expect(button, `button ${label}`).toBeDefined();
  expect(button?.disabled).not.toBe(true);
  (button?.onClick as (() => void) | undefined)?.();
}
function submit() {
  expect(fixture.forms).toHaveLength(1);
  const form = fixture.forms[0];
  if (!form) throw new Error("Missing setup form");
  (form.onSubmit as (event: FormEvent) => void)({
    preventDefault: vi.fn(),
  } as unknown as FormEvent);
}
function change(control: Record<string, unknown> | undefined, value: string) {
  expect(control).toBeDefined();
  if (!control) throw new Error("Missing form control");
  (control.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.mode = "setup";
  fixture.seeds = {};
  fixture.pendingCreate = false;
  fixture.initialOfferId = null;
  fixture.service = { ...querySnapshot(service()), refetch: fixture.serviceRefetch };
  fixture.receiving = {
    ...querySnapshot({
      state: "unknown",
      mxHost: null,
      mx: { status: "unknown", value: null },
      mailboxes: [],
    }),
    refetch: fixture.receivingRefetch,
  };
  fixture.billing = querySnapshot(billing());
  fixture.create.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });
  fixture.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/synthetic" });
  fixture.invalidate.mockResolvedValue(undefined);
  changed.mockResolvedValue(undefined);
});

describe.each(["en", "pt-BR"] as const)("mailbox setup in %s", (locale) => {
  it("starts with the verified sending domain without claiming receiving is ready", () => {
    const html = render(locale);
    const t = translate(locale);
    expect(plain(html)).toContain(t("domainBody"));
    expect(plain(html)).toContain(t("sendingVerified"));
    expect(plain(html)).toContain(t("receiving.unknown"));
    expect(plain(html)).not.toContain(t("receiving.ready"));
    expect(plain(html)).toContain(t("existingProviderBody"));
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/);
    const input = fixture.queries.find((query) => query.kind === "receiving");
    expect(input).toMatchObject({
      input: { domainId: verifiedDomain.id },
      enabled: true,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it.each(["needs_mx", "needs_activation", "ready"] as const)(
    "shows the actual receiving state %s separately from sending",
    (state) => {
      fixture.receiving.data = {
        state,
        mxHost: "inbound.synthetic.invalid",
        mx: { status: state, value: "inbound.synthetic.invalid" },
        mailboxes: [],
      };
      const text = plain(render(locale));
      const t = translate(locale);
      expect(text).toContain(t(`receiving.${state}`));
      expect(text.includes("inbound.synthetic.invalid")).toBe(state === "needs_mx");
      expect(text).toContain(t("existingProviderBody"));
    },
  );
  it.each(["pending", "fetching", "error", "no_data"] as const)(
    "does not show a cached ready result while %s",
    (state) => {
      fixture.receiving.data = {
        state: "ready",
        mxHost: "inbound.synthetic.invalid",
        mx: { status: "ready", value: "inbound.synthetic.invalid" },
        mailboxes: [],
      };
      fixture.receiving.isPending = state === "pending";
      fixture.receiving.isFetching = state === "fetching";
      fixture.receiving.isError = state === "error";
      if (state === "no_data") fixture.receiving.data = undefined;
      const html = render(locale);
      const t = translate(locale);
      expect(plain(html)).not.toContain(t("receiving.ready"));
      expect(plain(html)).toContain(
        t(
          state === "error"
            ? "receivingError"
            : state === "no_data"
              ? "receiving.unknown"
              : "receivingChecking",
        ),
      );
      if (state === "error") expect(html).toContain('role="alert"');
    },
  );
  it("lets the user explicitly recheck only the selected domain", () => {
    render(locale);
    change(fixture.controls[0], pendingDomain.id);
    const html = render(locale);
    expect(plain(html)).toContain(translate(locale)("sendingPending"));
    expect(fixture.queries.find((query) => query.kind === "receiving")?.input).toEqual({
      domainId: pendingDomain.id,
    });
    click(translate(locale)("checkReceiving"));
    expect(fixture.receivingRefetch).toHaveBeenCalledOnce();
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("provides a domain entry point instead of suggesting an address can be reserved without one", () => {
    const html = render(locale, { ...options, domains: [] });
    expect(plain(html)).toContain(translate(locale)("noDomainsTitle"));
    expect(html).toContain('href="/domains/new"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(fixture.queries.find((query) => query.kind === "receiving")?.enabled).toBe(false);
  });
  it("shows internal storage and uncapped sending without the historical pilot allowance", () => {
    fixture.service.data = service({
      unlimitedOutbound: true,
      storageBytesPerMailbox: 50 * 1024 ** 3,
      periodStart: null,
      periodEnd: null,
    });
    fixture.seeds[0] = 1;
    const text = plain(render(locale));
    const t = translate(locale);
    expect(text).toContain(t("systemLicenseReady"));
    expect(text).toContain(t("licenseUnlimited", { used: 5 }));
    expect(text).toContain("50 GiB");
    expect(text).toContain(t("systemUnlimitedOutbound"));
    expect(text).not.toContain(t("outboundCount", { count: 100 }));
    expect(text).not.toContain(t("licenseSeats", { used: 5, total: 2 }));
    expect(text).toContain(t("systemResourceLimitsBody"));
    expect(fixture.queries.find((query) => query.kind === "billing")?.enabled).toBe(false);
  });
  it("keeps mailbox registration available while an operational System cycle needs configuration", () => {
    fixture.service.data = service({
      resourcePolicyActive: false,
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    fixture.seeds = { 0: 1 };
    expect(plain(render(locale))).toContain(translate(locale)("resourcePolicyPending"));
    fixture.seeds = { 0: 3, 2: "agent" };
    const html = render(locale);
    expect(html).toMatch(/<button(?=[^>]*type="submit")(?![^>]*disabled)[^>]*>/);
    expect(plain(html)).toContain(translate(locale)("systemLicenseReady"));
  });
  it.each(["full", "inactive", "loading", "error"] as const)(
    "does not register an address when the license is %s",
    (state) => {
      fixture.seeds = { 0: 3, 2: "agent" };
      fixture.service.data = service({
        licenseKind: "subscription",
        unlimitedSeats: false,
        reservedSeats: 2,
        active: state !== "inactive",
      });
      fixture.service.isPending = state === "loading";
      fixture.service.isError = state === "error";
      const html = render(locale);
      const t = translate(locale);
      expect(plain(html)).toContain(t(`seats.${state}.title`));
      expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
      submit();
      expect(fixture.create).not.toHaveBeenCalled();
    },
  );
  it("keeps local-part validation until the address step and supports going back", () => {
    render(locale);
    submit();
    expect(fixture.seeds[0]).toBe(1);
    render(locale);
    submit();
    expect(fixture.seeds[0]).toBe(2);
    render(locale);
    submit();
    const html = render(locale);
    expect(plain(html)).toContain(translate(locale)("errors.addressInvalid"));
    expect(fixture.create).not.toHaveBeenCalled();
    click(translate(locale)("back"));
    expect(fixture.seeds[0]).toBe(1);
  });
  it.each(["person", "agent"] as const)(
    "registers the selected %s address without claiming DNS or agent activation",
    async (kind) => {
      fixture.seeds[0] = 2;
      render(locale);
      change(
        fixture.controls.find((control) => control.autoCapitalize === "none"),
        " New.Agent ",
      );
      click(translate(locale)(`${kind}Title`) + translate(locale)(`${kind}Body`));
      render(locale);
      submit();
      expect(fixture.seeds[0]).toBe(3);
      const review = plain(render(locale));
      expect(review).toContain(`new.agent@${verifiedDomain.name}`);
      expect(review).toContain(translate(locale)("reservationBody"));
      submit();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
        domainId: verifiedDomain.id,
        localPart: "new.agent",
        label: "new.agent",
        kind,
        ownerUserId: owner.id,
      });
      const saved = plain(render(locale));
      expect(saved).toContain(translate(locale)("savedTitle"));
      expect(saved).toContain(translate(locale)("nextBody"));
      expect(saved.includes(translate(locale)("agentNext"))).toBe(kind === "agent");
      expect(fixture.checkout).not.toHaveBeenCalled();
      expect(fixture.manage).not.toHaveBeenCalled();
    },
  );
  it("preserves a confirmed reservation after the parent refresh fails", async () => {
    changed.mockRejectedValueOnce(new Error("synthetic refresh failure"));
    fixture.seeds = { 0: 3, 2: "reserved" };
    render(locale);
    submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const text = plain(render(locale));
    expect(text).toContain(translate(locale)("savedTitle"));
    expect(text).not.toContain("synthetic refresh failure");
    expect(fixture.create).toHaveBeenCalledOnce();
  });
  it("keeps the entered address on a real late quota refusal without exposing the raw error", async () => {
    fixture.create.mockRejectedValueOnce({
      data: { code: "PRECONDITION_FAILED" },
      message: "quota",
      privateDetails: "synthetic private provider metadata",
    });
    fixture.seeds = { 0: 3, 2: "keep-me", 4: "agent" };
    render(locale);
    submit();
    await vi.waitFor(() => expect(fixture.serviceRefetch).toHaveBeenCalledOnce());
    const text = plain(render(locale));
    expect(text).toContain(`keep-me@${verifiedDomain.name}`);
    expect(text).toContain(translate(locale)("errors.quota"));
    expect(text).not.toContain("synthetic private provider metadata");
    expect(changed).not.toHaveBeenCalled();
  });
});

describe.each(["en", "pt-BR"] as const)("mailbox license presentation in %s", (locale) => {
  it("separates the permanent System license from resource limits and ignores billing errors", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      unlimitedOutbound: true,
      storageBytesPerMailbox: 50 * 1024 ** 3,
      periodStart: null,
      periodEnd: null,
    });
    fixture.billing.data = billing({ sendingPlanRequired: true });
    fixture.billing.isError = true;
    const html = render(locale);
    const text = plain(html);
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(text).toContain(t("system.unlimitedMailboxes"));
    expect(text).toContain(t("system.noSubscription"));
    expect(text).toContain(t("resourcesTitle"));
    expect(text).toContain(t("system.resourceLimitsBody"));
    expect(text).toContain("50 GiB");
    expect(text).toContain(t("system.unlimitedOutbound"));
    expect(text).toContain(t("system.internalUsageActiveBody"));
    expect(text).not.toContain(t("messageCount", { count: 100 }));
    expect(text).not.toContain(t("system.operationalCycle"));
    expect(text).not.toContain(t("loadError"));
    expect(text).not.toContain(t("subscribe"));
    expect(text).not.toContain(t("manageQuantity"));
    expect(text).not.toContain(t("sendingPlanRequiredBody"));
    expect(html).not.toContain('href="/settings/billing"');
    expect(fixture.queries.find((query) => query.kind === "billing")?.enabled).toBe(false);
  });
  it("does not relabel an expired operational cycle as an expired System license", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      resourcePolicyActive: false,
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(text).toContain(t("system.active"));
    expect(text).toContain(t("system.cycleInactiveBody"));
    expect(text).not.toContain(t("status.expired"));
    expect(text).not.toContain(t("subscribe"));
  });
  it("does not offer fake purchase terms when the catalog is unavailable", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      active: false,
      licenseKind: "none",
      unlimitedSeats: false,
      seats: 0,
      reservedSeats: 0,
    });
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(text).toContain(t("unavailableBody"));
    expect(text).not.toContain(t("subscribe"));
    expect(text).not.toMatch(/\$\s*\d/);
    expect(fixture.checkout).not.toHaveBeenCalled();
  });
  it("renders only the monthly USD offer and allowances returned by the catalog", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      active: false,
      licenseKind: "none",
      unlimitedSeats: false,
      seats: 0,
      reservedSeats: 0,
    });
    fixture.billing.data = billing({
      availability: "available",
      canPurchase: true,
      offer: {
        unitAmount: 1250,
        currency: "usd",
        interval: "month",
        storageBytesPerMailbox: 2 * 1024 ** 3,
        includedOutboundPerMailbox: 500,
      },
    });
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "usd" }).format(
      12.5,
    );
    expect(text).toContain(t("priceInterval", { amount, interval: t("interval.month") }));
    expect(text).toContain(t("includedSummary", { storage: "2 GiB", messages: 500 }));
    expect(text).toContain(t("confirmationHint"));
    expect(text).toContain(t("subscribe"));
    expect(fixture.checkout).not.toHaveBeenCalled();
  });
});

describe.each(["en", "pt-BR"] as const)("Mail add-on requirement in %s", (locale) => {
  const t = createTranslator({
    locale,
    messages: messages[locale],
    namespace: "mailboxes-service",
  });

  it("directs a team without paid Send to billing and prevents checkout", () => {
    fixture.mode = "panel";
    purchasable({
      availability: "sending_plan_required",
      sendingPlanRequired: true,
      canPurchase: false,
    });
    const html = render(locale);
    const text = plain(html);
    expect(text).toContain(t("equalPrice"));
    expect(text).toContain(t("sendingPlanRequiredBody"));
    expect(text).toContain(t("viewSendingPlans"));
    expect(text).toContain(t("recoveryReads"));
    expect(text).not.toContain(t("unavailableBody"));
    expect(html).toContain('href="/settings/billing"');
    expect(fixture.forms).toHaveLength(0);
    expect(fixture.checkout).not.toHaveBeenCalled();
  });

  it("keeps cancellation and status refresh available while restricting an existing contract to reductions", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      licenseKind: "subscription",
      unlimitedSeats: false,
      seats: 5,
      reservedSeats: 2,
    });
    fixture.billing.data = billing({
      availability: "existing_subscription",
      sendingPlanRequired: true,
      canManage: true,
      management: {
        canReconcile: true,
        canAdjust: true,
        canIncrease: false,
        canCancel: true,
        canResume: false,
        pending: false,
        scheduledSeats: null,
        requestedSeats: null,
        effectiveAt: null,
      },
    });
    const text = plain(render(locale));
    expect(text).toContain(t("sendingPlanRequiredBody"));
    expect(text).toContain(t("existingLicenseBody"));
    expect(text).toContain(t("cancelAtEnd"));
    expect(text).toContain(t("refresh"));
    expect(text).not.toContain(t("resumeRenewal"));
    expect(fixture.buttons.find((button) => button.children === t("cancelAtEnd"))?.disabled).toBe(
      false,
    );
    const control = fixture.controls.find((entry) => entry.type === "number");
    expect(control?.max).toBe(5);
    change(control, "6");
    render(locale);
    expect(
      fixture.buttons.find((button) => button.children === t("requestIncrease"))?.disabled,
    ).toBe(true);
    const quantityForm = fixture.forms[0];
    if (!quantityForm) throw new Error("Missing quantity form");
    (quantityForm.onSubmit as (event: FormEvent) => void)({
      preventDefault: vi.fn(),
    } as unknown as FormEvent);
    expect(fixture.manage).not.toHaveBeenCalled();
    change(
      fixture.controls.find((entry) => entry.type === "number"),
      "3",
    );
    render(locale);
    expect(
      fixture.buttons.find((button) => button.children === t("requestReduction"))?.disabled,
    ).toBe(false);
    const reductionForm = fixture.forms[0];
    if (!reductionForm) throw new Error("Missing reduction form");
    (reductionForm.onSubmit as (event: FormEvent) => void)({
      preventDefault: vi.fn(),
    } as unknown as FormEvent);
    expect(fixture.manage).toHaveBeenCalledExactlyOnceWith({ action: "quantity", seats: 3 });
    expect(fixture.checkout).not.toHaveBeenCalled();
  });

  it("allows an eligible paid Send contract to request an increase", () => {
    fixture.mode = "panel";
    fixture.service.data = service({
      licenseKind: "subscription",
      unlimitedSeats: false,
      seats: 5,
    });
    fixture.billing.data = billing({
      availability: "existing_subscription",
      management: {
        canReconcile: true,
        canAdjust: true,
        canIncrease: true,
        canCancel: true,
        canResume: false,
        pending: false,
        scheduledSeats: null,
        requestedSeats: null,
        effectiveAt: null,
      },
    });
    render(locale);
    const control = fixture.controls.find((entry) => entry.type === "number");
    expect(control?.max).toBe(10000);
    change(control, "6");
    const text = plain(render(locale));
    expect(text).not.toContain(t("sendingPlanRequiredBody"));
    expect(
      fixture.buttons.find((button) => button.children === t("requestIncrease"))?.disabled,
    ).toBe(false);
  });

  it("maps a late Send eligibility refusal to the billing CTA without exposing provider details", () => {
    fixture.mode = "panel";
    purchasable();
    fixture.seeds[3] = mailboxCheckoutFailure({
      message: "sending_plan_required",
      data: { code: "PRECONDITION_FAILED" },
      privateDetails: "synthetic private provider metadata",
    });
    const html = render(locale);
    const text = plain(html);
    expect(text).toContain(t("sendingPlanRequiredBody"));
    expect(text).not.toContain(t("pendingBody"));
    expect(text).not.toContain(t("unavailableBody"));
    expect(text).not.toContain("synthetic private provider metadata");
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/settings/billing"');
    expect(fixture.forms).toHaveLength(0);
  });
});

it("preserves existing contract notices and recognizes the Send purchase prerequisite", () => {
  expect(mailboxServiceNotice("sending_plan_required", null)).toBe("sendingPlanRequiredBody");
  expect(mailboxServiceNotice("existing_subscription", instant)).toBe("existingLicenseBody");
  expect(mailboxServiceNotice("sending_plan_required", instant, true)).toBe("existingLicenseBody");
});

describe.each(["en", "pt-BR"] as const)("mailbox plan choices in %s", (locale) => {
  it("keeps the chosen plan from license preparation through the purchase panel", () => {
    purchasable();
    fixture.seeds[0] = 1;
    render(locale);
    change(
      fixture.controls.find((control) => control.value === oneOffer.offerId),
      tenOffer.offerId,
    );
    const wizard = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(wizard).toContain(t("selectedPlanAllowance", { storage: "10 GiB", messages: 2000 }));
    click(t("reviewSelectedPlan"));
    expect(reviewLicense).toHaveBeenCalledExactlyOnceWith(tenOffer.offerId);
    // The parent carries only the public offer ID; the panel reads current terms again.
    fixture.mode = "panel";
    fixture.seeds = {};
    fixture.initialOfferId = tenOffer.offerId;
    const panel = plain(render(locale));
    expect(fixture.controls.find((control) => control.value === tenOffer.offerId)).toBeDefined();
    expect(panel).toContain(t("includedSummary", { storage: "10 GiB", messages: 2000 }));
  });
  it("uses the selected offer ID and actual quantity in checkout instead of the default plan", () => {
    fixture.mode = "panel";
    purchasable();
    render(locale);
    change(
      fixture.controls.find((control) => control.value === oneOffer.offerId),
      tenOffer.offerId,
    );
    render(locale);
    change(
      fixture.controls.find((control) => control.type === "number"),
      "3",
    );
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "usd" }).format(
      112.5,
    );
    expect(text).toContain(t("priceInterval", { amount, interval: t("interval.month") }));
    expect(text).toContain(t("total", { count: 3 }));
    submit();
    expect(fixture.checkout).toHaveBeenCalledExactlyOnceWith({
      seats: 3,
      offerId: tenOffer.offerId,
    });
  });
  it("resumes the pending 10 GiB purchase even when the default and requested choice are 1 GiB", () => {
    fixture.mode = "panel";
    fixture.initialOfferId = oneOffer.offerId;
    purchasable({
      pendingOfferId: tenOffer.offerId,
      pendingOffer: tenOffer,
      pendingCheckoutSeats: 2,
      checkoutPending: true,
    });
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(text).toContain(t("planLocked"));
    expect(text).toContain(t("includedSummary", { storage: "10 GiB", messages: 2000 }));
    expect(text).toContain(t("retryCheckout"));
    expect(fixture.controls.find((control) => control.value === tenOffer.offerId)?.disabled).toBe(
      true,
    );
    expect(fixture.controls.find((control) => control.type === "number")?.disabled).toBe(true);
    submit();
    expect(fixture.checkout).toHaveBeenCalledExactlyOnceWith({
      seats: 2,
      offerId: tenOffer.offerId,
    });
  });
  it("replaces a local three-mailbox attempt with the fresh pending two-mailbox plan", async () => {
    fixture.mode = "panel";
    purchasable();
    render(locale);
    change(
      fixture.controls.find((control) => control.type === "number"),
      "3",
    );
    render(locale);
    submit();
    expect(fixture.checkout).toHaveBeenCalledExactlyOnceWith({
      seats: 3,
      offerId: oneOffer.offerId,
    });
    await Promise.resolve();
    purchasable({
      pendingOfferId: tenOffer.offerId,
      pendingOffer: tenOffer,
      pendingCheckoutSeats: 2,
      checkoutPending: true,
    });
    fixture.checkout.mockClear();
    render(locale);
    expect(fixture.controls.find((control) => control.type === "number")?.value).toBe(2);
    expect(fixture.controls.find((control) => control.value === tenOffer.offerId)?.disabled).toBe(
      true,
    );
    submit();
    expect(fixture.checkout).toHaveBeenCalledExactlyOnceWith({
      seats: 2,
      offerId: tenOffer.offerId,
    });
    await Promise.resolve();
    // A confirmed pending ID without its quantity cannot borrow a local attempted quantity.
    purchasable({
      pendingOfferId: tenOffer.offerId,
      pendingOffer: tenOffer,
      pendingCheckoutSeats: null,
    });
    fixture.checkout.mockClear();
    render(locale);
    expect(fixture.forms).toHaveLength(0);
    expect(fixture.checkout).not.toHaveBeenCalled();
  });
  it.each(["terms", "quantity"] as const)(
    "does not open another purchase when pending %s are missing",
    (missing) => {
      fixture.mode = "panel";
      purchasable({
        pendingOfferId: tenOffer.offerId,
        pendingOffer: missing === "terms" ? null : tenOffer,
        pendingCheckoutSeats: missing === "quantity" ? null : 2,
      });
      const text = plain(render(locale));
      const t = createTranslator({
        locale,
        messages: messages[locale],
        namespace: "mailboxes-service",
      });
      expect(text).toContain(t("pendingOfferUnavailable"));
      expect(fixture.forms).toHaveLength(0);
      expect(fixture.checkout).not.toHaveBeenCalled();
    },
  );
  it("uses the current default when a requested plan is no longer in the catalog", () => {
    fixture.mode = "panel";
    fixture.initialOfferId = tenOffer.offerId;
    const current = { ...oneOffer, unitAmount: 1550 };
    purchasable({ offers: [current], offer: current, defaultOfferId: current.offerId });
    render(locale);
    expect(fixture.controls.find((control) => control.value === current.offerId)).toBeDefined();
    submit();
    expect(fixture.checkout).toHaveBeenCalledExactlyOnceWith({
      seats: 1,
      offerId: current.offerId,
    });
  });
  it("does not display selectable plans or checkout for System even if billing returns offers", () => {
    fixture.billing.data = billing({
      canPurchase: true,
      offers: [oneOffer, tenOffer],
      offer: oneOffer,
      defaultOfferId: oneOffer.offerId,
    });
    fixture.seeds[0] = 1;
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(plain(render(locale))).not.toContain(t("planChoice"));
    expect(fixture.queries.find((query) => query.kind === "billing")?.enabled).toBe(false);
    fixture.mode = "panel";
    fixture.seeds = {};
    const text = plain(render(locale));
    expect(text).toContain(t("system.unlimitedMailboxes"));
    expect(text).not.toContain(t("planChoice"));
    expect(fixture.forms).toHaveLength(0);
    expect(fixture.checkout).not.toHaveBeenCalled();
  });
  it("does not offer a new purchase while the server has paused contracting", () => {
    fixture.mode = "panel";
    purchasable({
      canPurchase: false,
      offers: [],
      offer: null,
      defaultOfferId: null,
      pendingOfferId: tenOffer.offerId,
      pendingOffer: tenOffer,
      pendingCheckoutSeats: 2,
    });
    const text = plain(render(locale));
    const t = createTranslator({
      locale,
      messages: messages[locale],
      namespace: "mailboxes-service",
    });
    expect(text).toContain(t("unavailableBody"));
    expect(text).not.toContain(t("subscribe"));
    expect(fixture.forms).toHaveLength(0);
  });
});

it("uses the existing responsive tokens and wraps the four steps and domain at narrow widths", () => {
  const css = readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailbox-setup-dialog.module.css", import.meta.url),
    "utf8",
  );
  expect(css).toContain("var(--ms-panel)");
  expect(css).toContain("var(--ms-bone)");
  expect(css).toContain("overflow-wrap: anywhere");
  expect(css).toContain("min-height: 44px");
  expect(css).toMatch(
    /@media \(max-width: 520px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
});
