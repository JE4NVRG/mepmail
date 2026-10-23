// Integrated customer journey: real auth and business rules, synthetic external transports.
// Business/auth/permissions stay real. Only external transports are fakes.
import { readdirSync, readFileSync } from "node:fs";
import {
  type BillingStripe,
  handleWebhook,
  type MailboxCatalog,
  type PixStripe,
} from "@millionsend/billing";
import type { SystemMailMessage } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { dnsChecklist } from "@millionsend/ses";
import { createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { getActiveMembership } from "@/server/membership";
import { createBillingRouter } from "@/server/routers/billing";
import { consoleTeamsRouter } from "@/server/routers/console/teams";
import { createDomainsRouter, type DomainsSesDeps } from "@/server/routers/domains";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { teamBootstrapRouter } from "@/server/routers/team-bootstrap";
import { defaultSystemMailDeps } from "@/server/system-mail";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import {
  SEND_INTRO_COUPON,
  SEND_LAUNCH_OFFER,
  sendLaunchLookupKey,
} from "../../../packages/billing/src/send-launch-offer.js";
import { price, subscription, webhooks } from "../../../packages/billing/test/helpers.js";
import { checkoutProvider } from "../../../packages/billing/test/send-checkout-fixture.js";

const ports = vi.hoisted(() => ({
  stripe: null as BillingStripe | null,
  pix: null as PixStripe | null,
}));
vi.mock("@/server/billing", async (original) => {
  const actual = await original<typeof import("@/server/billing")>();
  return {
    ...actual,
    getStripe: () => {
      if (!ports.stripe) throw new Error("Synthetic Stripe transport is not installed");
      return ports.stripe;
    },
    getPixStripe: () => {
      if (!ports.pix) throw new Error("Synthetic Pix transport is not installed");
      return ports.pix;
    },
  };
});

const BASE = "http://localhost:3000";
const PASSWORD = "synthetic correct horse battery";
const WEBHOOK_SECRET = "whsec_synthetic_customer_journey_only";
const GIB = 1024 ** 3;
const MAIL_TERMS = {
  priceId: "price_journey_equipe",
  currency: "usd",
  unitAmount: 1290,
  interval: "month" as const,
  storageBytesPerMailbox: 10 * GIB,
  includedOutboundPerMailbox: 10_000,
  quotaScope: "team" as const,
  includedMailboxes: 10,
  planCode: "equipe" as const,
  trialDays: 7,
  localCurrency: { currency: "brl", unitAmount: 6490 },
  inboundDeliveriesPerPeriod: 10_000,
  inboundBytesPerPeriod: 3 * GIB,
  outboundBytesPerPeriod: 5 * GIB,
};
const MAIL_CATALOG: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: null,
  checkoutPriceIds: [],
  standalonePriceIds: [MAIL_TERMS.priceId],
  prices: [MAIL_TERMS],
};
type Actor = { headers: Headers; activeTeamId?: string };
let db: Db;
let close: (() => Promise<void>) | undefined;
let sent: SystemMailMessage[];
let provider: ReturnType<typeof checkoutProvider>;
let stripeCalls: string[];
let sesVerified: boolean;
let dnsRows: Array<{ type: string; name: string; value: string; priority?: number }>;
let auth: ReturnType<typeof createAuth>;
let factory: ReturnType<typeof journeyCallerFactory>;

/** Instruments every SDK method, including reads; no real SDK HTTP client is used. */
function observed<T extends object>(object: T, prefix = "stripe"): T {
  return new Proxy(object, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value === "function")
        return (...args: unknown[]) => {
          stripeCalls.push(`${prefix}.${String(key)}`);
          return Reflect.apply(value, target, args);
        };
      return value && typeof value === "object"
        ? observed(value, `${prefix}.${String(key)}`)
        : value;
    },
  });
}

function domainPorts(): DomainsSesDeps {
  return {
    clientForRegion: () => ({
      async send(command) {
        if (command.constructor.name === "GetEmailIdentityCommand")
          return {
            VerifiedForSendingStatus: sesVerified,
            DkimAttributes: { Status: sesVerified ? "SUCCESS" : "PENDING" },
            MailFromAttributes: { MailFromDomainStatus: sesVerified ? "SUCCESS" : "PENDING" },
          };
        if (["CreateTenantCommand", "GetTenantCommand"].includes(command.constructor.name)) {
          const { TenantName } = (command as unknown as { input: { TenantName: string } }).input;
          const arn = `arn:aws:ses:us-east-1:123456789012:tenant/${TenantName}`;
          return command.constructor.name === "CreateTenantCommand"
            ? { TenantArn: arn }
            : { Tenant: { TenantArn: arn } };
        }
        return {};
      },
    }),
    resolveNs: async () => [],
    receivingMx: () => null,
    dns: {
      resolveTxt: async (name) =>
        dnsRows.filter((r) => r.type === "TXT" && r.name === name).map((r) => [r.value]),
      resolveMx: async (name) =>
        dnsRows
          .filter((r) => r.type === "MX" && r.name === name)
          .map((r) => ({ exchange: r.value, priority: r.priority ?? 10 })),
      resolveCname: async (name) =>
        dnsRows.filter((r) => r.type === "CNAME" && r.name === name).map((r) => r.value),
    },
  };
}
function journeyRouter() {
  return router({
    team: teamBootstrapRouter,
    domains: createDomainsRouter(domainPorts()),
    billing: createBillingRouter({ stripe: () => ports.stripe! }),
    mailboxes: mailboxesRouter,
    console: router({ teams: consoleTeamsRouter }),
  });
}

function journeyCallerFactory() {
  return createCallerFactory(journeyRouter());
}

beforeEach(async () => {
  // All values are isolated test configuration, never credentials from a runtime.
  const configuration = {
    IS_CLOUD: "true",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
    APP_BASE_URL: BASE,
    ALLOW_SIGNUP: "true",
    AUTH_EMAIL_FROM: "MepMail <no-reply@mail.example.com>",
    AWS_ACCESS_KEY_ID: "test-key",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    AWS_DEFAULT_CHAIN: "",
    AWS_REGION: "us-east-1",
    SIGNUP_BOT_PROTECTION: "true",
    TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    STRIPE_SECRET_KEY: "sk_test_synthetic_only",
    SEND_LAUNCH_OFFER_ENABLED: "true",
    BILLING_MUTATIONS_PAUSED: "false",
    NEW_SUBSCRIPTIONS_PAUSED: "false",
    PIX_PAYMENTS_OPEN: "true",
    MAILBOX_REGISTRY_ENABLED: "true",
    MAILBOX_EARLY_ACCESS_OPEN: "true",
    MAILBOX_STANDALONE_OPEN: "true",
    MAILBOX_BILLING_PAUSED: "false",
    MAILBOX_BILLING_CATALOG: JSON.stringify(MAIL_CATALOG),
    MAILBOX_EARLY_ACCESS_COHORT: JSON.stringify({
      version: 1,
      capturedAt: "2020-01-01T00:00:00.000Z",
      members: [],
    }),
    OPERATOR_ALERTS_SINK: "audit",
    UMAMI_ENDPOINT: "",
    UMAMI_WEBSITE_ID: "",
  };
  for (const [name, value] of Object.entries(configuration)) vi.stubEnv(name, value);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://challenges.cloudflare.com/turnstile/v0/siteverify")
        return Response.json({ success: true, hostname: "localhost", action: "auth" });
      throw new Error("Unexpected external HTTP transport in isolated journey");
    }),
  );
  ({ db, close } = await createTestDb());
  // Real optional Correio migrations, exactly as the canonical billing suites apply them.
  const extension = new URL("../../../packages/db/mailbox-drizzle/", import.meta.url);
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(new URL(file, extension), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
  sent = [];
  stripeCalls = [];
  sesVerified = false;
  dnsRows = [];
  vi.spyOn(defaultSystemMailDeps, "send").mockImplementation(async (message) => {
    sent.push(message);
  });
  auth = createAuth(db, {
    send: async (message) => {
      sent.push(message);
    },
  });
  provider = checkoutProvider();
  const launchPrice = {
    ...price("millionsend_pro_100k_monthly"),
    id: "price_launch_month",
    lookup_key: sendLaunchLookupKey("month"),
    livemode: false,
    product: "prod_send_launch",
    unit_amount: 2900,
    metadata: {
      millionsend_rung: "pro_100k",
      plan: "pro",
      included_emails: "110000",
      period: "month",
      regular_monthly_cents: "2900",
      mepmail_send_offer: SEND_LAUNCH_OFFER,
    },
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  } as unknown as Stripe.Price;
  const list = provider.stripe.prices.list;
  provider.stripe.prices.list = async (params) =>
    params.lookup_keys?.includes(launchPrice.lookup_key!)
      ? ({ data: [launchPrice], has_more: false } as Stripe.ApiList<Stripe.Price>)
      : list(params).then((page) => ({
          ...page,
          data: page.data.map((p) => ({ ...p, livemode: false })),
        }));
  provider.stripe.coupons = {
    retrieve: async () =>
      ({
        id: SEND_INTRO_COUPON,
        valid: true,
        livemode: false,
        currency: "usd",
        amount_off: 900,
        percent_off: null,
        duration: "once",
        applies_to: { products: ["prod_send_launch"] },
        currency_options: { brl: { amount_off: 5000 } },
        metadata: { mepmail_send_offer: SEND_LAUNCH_OFFER },
      }) as unknown as Stripe.Coupon,
  };
  provider.stripe.invoices = {
    retrieve: async () => {
      throw new Error("Unexpected invoice read in synthetic transport");
    },
    list: async () => ({ data: [], has_more: false }) as unknown as Stripe.ApiList<Stripe.Invoice>,
  };
  ports.stripe = observed(provider.stripe);
  // All Pix attempts in this file are negatives. Any SDK access fails the expected reason assertion.
  ports.pix = new Proxy({} as PixStripe, {
    get(_target, property) {
      stripeCalls.push(`pix.${String(property)}`);
      throw new Error("Pix transport was reached before purchase eligibility");
    },
  });
  factory = journeyCallerFactory();
});
afterEach(async () => {
  await close?.();
  close = undefined;
  ports.stripe = null;
  ports.pix = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function postAuth(path: string, body: object, captcha = true) {
  return auth.handler(
    new Request(`${BASE}/api/auth/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(captcha ? { "x-captcha-response": "synthetic-challenge-response" } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function registerAndVerify(email: string, name: string): Promise<Actor> {
  const created = await postAuth("sign-up/email", {
    email,
    name,
    password: PASSWORD,
    callbackURL: "/verify-email",
  });
  expect(created.status).toBe(200);
  expect(((await created.json()) as { token: string | null }).token).toBeNull();
  expect((await postAuth("sign-in/email", { email, password: PASSWORD })).status).toBe(403);
  const message = sent.find((mail) => mail.kind === "email_verification" && mail.to === email);
  expect(message).toBeDefined();
  const link = message!.text.match(/https?:\/\/\S+/)?.[0];
  expect(link).toBeTruthy();
  expect(
    (await auth.handler(new Request(link!, { headers: { "accept-language": "pt-BR" } }))).status,
  ).toBe(302);
  const login = await postAuth("sign-in/email", { email, password: PASSWORD });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  expect(cookie).not.toBe("");
  const actor = { headers: new Headers({ cookie }) };
  const session = await auth.api.getSession({ headers: actor.headers });
  expect(session?.user).toMatchObject({ email, emailVerified: true });
  return actor;
}
async function caller(actor: Actor) {
  const session = await auth.api.getSession({ headers: actor.headers });
  if (!session) throw new Error("The real Better Auth session is required");
  const membership = await getActiveMembership(db, session.user.id, actor.activeTeamId);
  const ctx: Context = {
    db,
    session,
    teamId: membership?.teamId ?? null,
    role: membership?.role ?? null,
    setActiveTeamCookie: (id) => {
      actor.activeTeamId = id;
    },
  };
  return factory(ctx);
}
async function teamRow(id: string) {
  return (await db.select().from(schema.teams).where(eq(schema.teams.id, id)))[0]!;
}
async function assertNoPurchase(id: string) {
  expect(stripeCalls).toEqual([]); // Includes all Customer/Session/Invoice methods and provider reads.
  expect(provider.posts).toEqual([]);
  expect(provider.state.customers).toEqual([]);
  expect(provider.state.checkouts).toEqual([]);
  expect(await db.select().from(schema.mailboxCustomerRequests)).toEqual([]);
  expect(await db.select().from(schema.sendCheckoutAttempts)).toEqual([]);
  expect(await db.select().from(schema.mailboxCheckouts)).toEqual([]);
  expect(await db.select().from(schema.mailboxSubscriptions)).toEqual([]);
  expect(await teamRow(id)).toMatchObject({
    plan: "free",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  });
}
async function refuseFourMethods(
  actor: Actor,
  reason: "domain_required" | "domain_review",
  id: string,
) {
  const customer = await caller(actor);
  for (const attempt of [
    () => customer.billing.checkout({ rung: "pro_100k", interval: "month" }),
    () => customer.billing.pixCheckout({ rung: "pro_100k", interval: "month" }),
    () => customer.mailboxes.checkout({ seats: 10 }),
    () => customer.mailboxes.pixCheckout({}),
  ])
    await expect(attempt()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: `PURCHASE_REVIEW_${reason.toUpperCase()}`,
    });
  await assertNoPurchase(id);
}

describe("new customer: real auth and routers before a synthetic payment", () => {
  it.each([
    { service: "send", domain: "send.example.test", review: false },
    { service: "mail", domain: "journey-mail.online", review: true },
  ] as const)(
    "$service: pending domain → eligibility → card checkout → subscription",
    async ({ service, domain, review }) => {
      const anonymous = factory({ db, session: null, teamId: null, role: null });
      await expect(anonymous.team.createTeam({ name: "Harbor Dispatch" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      const missingChallenge = await postAuth(
        "sign-up/email",
        { email: "blocked@example.com", name: "Blocked", password: PASSWORD },
        false,
      );
      expect(missingChallenge.status).toBe(403);
      expect(await db.select().from(schema.user)).toEqual([]);
      // The first real registered fixture account is the legitimate instance operator.
      const operator = await registerAndVerify("operator@example.com", "Fixture Operator");
      const buyer = await registerAndVerify("owner@example.com", "Harbor Owner");
      const { teamId } = await (await caller(buyer)).team.createTeam({ name: "Harbor Dispatch" });
      const customer = await caller(buyer);
      const { id: domainId } = await customer.domains.create({ name: domain, region: "us-east-1" });
      expect((await customer.domains.verify({ id: domainId })).status).toBe("pending");
      expect(await customer.billing.purchaseEligibility()).toMatchObject({
        eligible: false,
        code: "domain_required",
      });
      await refuseFourMethods(buyer, "domain_required", teamId);

      const [row] = await db.select().from(schema.domains).where(eq(schema.domains.id, domainId));
      expect(row).toBeDefined();
      dnsRows = dnsChecklist({ domain: row!, verification: null });
      sesVerified = true;
      expect((await customer.domains.verify({ id: domainId })).status).toBe("verified");
      if (review) {
        expect(await customer.billing.purchaseEligibility()).toMatchObject({
          eligible: false,
          code: "domain_review",
          domains: [domain],
        });
        expect((await teamRow(teamId)).sendReviewAt).toBeNull(); // Read-only preflight.
        expect(await customer.billing.requestPurchaseReview()).toMatchObject({
          eligible: false,
          code: "domain_review",
        });
        const use = "Transactional messages to customers who explicitly requested their receipts.";
        const receipt = await customer.team.requestSignupReview({ context: use });
        expect(
          await customer.team.requestSignupReview({
            context: "A retry must keep the original private context.",
          }),
        ).toEqual(receipt);
        expect(JSON.stringify(receipt)).not.toContain(use);
        expect((await teamRow(teamId)).sendReviewAt).toBeInstanceOf(Date);
        await refuseFourMethods(buyer, "domain_review", teamId);
        await expect(
          customer.console.teams.releaseSendReview({ id: teamId }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const console = await caller(operator);
        await console.console.teams.releaseSendReview({ id: teamId });
        await console.console.teams.resolveSignupReview({ id: teamId, reviewed: true });
        expect(await teamRow(teamId)).toMatchObject({
          sendReviewAt: null,
          sendReviewClearedAt: expect.any(Date),
        });
      } else {
        expect((await teamRow(teamId)).sendReviewAt).toBeNull(); // Ordinary verified domain needs no manual approval.
      }
      expect(await customer.billing.purchaseEligibility()).toMatchObject({
        eligible: true,
        code: "ready",
      });
      await assertNoPurchase(teamId);

      const result =
        service === "send"
          ? await customer.billing.checkout({ rung: "pro_100k", interval: "month" })
          : await customer.mailboxes.checkout({ seats: 10 });
      expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect(provider.state.customers).toHaveLength(1);
      expect(provider.state.checkouts).toHaveLength(1);
      expect((await teamRow(teamId)).plan).toBe("free"); // Redirect is not a payment or entitlement.
      expect(await db.select().from(schema.mailboxSubscriptions)).toEqual([]);
      const params = provider.state.checkouts[0]!;
      expect(params.line_items?.[0]?.quantity).toBe(1);
      if (service === "mail") expect(params.subscription_data?.trial_period_days).toBe(7);

      const owner = await teamRow(teamId);
      const epoch = Math.floor(Date.now() / 1000);
      const sub = subscription(
        `sub_journey_${service}`,
        owner.stripeCustomerId!,
        service === "mail" ? "trialing" : "active",
        "millionsend_pro_100k_monthly",
        {
          created: epoch - 10,
          ...(service === "send" ? { overageKey: "millionsend_pro_100k_overage" } : {}),
        },
      );
      sub.livemode = false;
      sub.metadata = { ...(params.subscription_data?.metadata ?? {}) } as Stripe.Metadata;
      sub.collection_method = "charge_automatically";
      for (const item of sub.items.data) {
        item.current_period_start = epoch - 10;
        item.current_period_end = epoch + 30 * 86400;
      }
      if (service === "mail") {
        sub.items.data[0]!.price = {
          ...sub.items.data[0]!.price,
          id: MAIL_TERMS.priceId,
          currency: "usd",
          unit_amount: 1290,
          billing_scheme: "per_unit",
          transform_quantity: null,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        } as Stripe.Price;
        sub.items.data[0]!.quantity = 1;
        sub.default_payment_method = {
          id: "pm_journey",
          type: "card",
          card: { fingerprint: "synthetic-card-fingerprint" },
        } as Stripe.PaymentMethod;
        sub.trial_start = epoch;
        sub.trial_end = epoch + 7 * 86400;
      } else {
        const prices = await provider.stripe.prices.list({
          lookup_keys: [sendLaunchLookupKey("month")],
        });
        sub.items.data[0]!.price = prices.data[0]!;
      }
      provider.state.subscriptions[sub.id] = sub;
      const payload = JSON.stringify({
        id: `evt_customer_journey_${service}`,
        object: "event",
        type: "customer.subscription.created",
        created: epoch,
        livemode: false,
        data: { object: sub },
      });
      const signature = webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
      const webhook = {
        db,
        stripe: ports.stripe!,
        webhookSecret: WEBHOOK_SECRET,
        livemode: false,
        mailboxCatalog: MAIL_CATALOG,
        log: () => {},
      };
      expect(await handleWebhook(payload, "invalid-signature", webhook)).toBe(400);
      expect(await handleWebhook(payload, signature, webhook)).toBe(200);
      expect(await handleWebhook(payload, signature, webhook)).toBe(200);
      expect(await db.select().from(schema.stripeEvents)).toHaveLength(1);
      if (service === "send") {
        expect(await teamRow(teamId)).toMatchObject({
          plan: "pro",
          planStatus: "active",
          stripeSubscriptionId: sub.id,
          planQuota: 110_000,
        });
      } else {
        expect((await teamRow(teamId)).plan).toBe("free"); // Correio preserves the Send service.
        expect(await db.select().from(schema.mailboxSubscriptions)).toEqual([
          expect.objectContaining({
            teamId,
            status: "trialing",
            seats: 10,
            planCode: "equipe",
            includedOutboundPerMailbox: 10_000,
          }),
        ]);
        expect(await db.select().from(schema.mailboxTrialClaims)).toHaveLength(1);
      }
    },
  );
});
