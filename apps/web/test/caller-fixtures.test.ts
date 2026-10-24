import strictAssert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as billingModule from "@millionsend/billing";
import {
  acceptEmail,
  EnvKeyring,
  encryptEmailBody,
  type FunnelEventTarget,
} from "@millionsend/core";
import * as dbModule from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, test, vi } from "vitest";
import type { BillingStripe } from "../../../packages/billing/src/stripe.js";
import { handleWebhook } from "../../../packages/billing/src/webhook.js";
import { fakeStripe, subscription, webhooks } from "../../../packages/billing/test/helpers.js";
import { type SesSender, sendEmail } from "../../worker/src/handlers/send-email.js";
import { createAuth } from "../src/server/auth.js";
import * as webBillingModule from "../src/server/billing.js";
import { emitFunnel, requestedFunnelIntent, trackTeamSignup } from "../src/server/funnel.js";
import { teamBootstrapRouter } from "../src/server/routers/team-bootstrap.js";
import type { Context } from "../src/server/trpc.js";

let checks = 0;
// Count assertions only after the real Node assertion succeeds, including injected transports.
const assert: Pick<typeof strictAssert, "equal" | "deepEqual" | "ok"> = {
  equal(...args) {
    strictAssert.equal(...args);
    checks++;
  },
  deepEqual(...args) {
    strictAssert.deepEqual(...args);
    checks++;
  },
  ok(...args) {
    strictAssert.ok(...args);
    checks++;
  },
};
const target: FunnelEventTarget = {
  hostname: "fixture.invalid",
  endpoint: "http://fixture.invalid",
  websiteId: "fixture",
  fetch: async () => new Response(null, { status: 200 }),
};
// Global network fence: a test may never send to Umami, Stripe, SES, Ads, or an account-mail provider.
globalThis.fetch = async () => {
  throw new Error("fixture-network-forbidden");
};
process.env.BETTER_AUTH_SECRET = "fixture-only-long-secret-never-a-real-credential-12345";
process.env.APP_BASE_URL = "https://fixture.invalid";
process.env.ALLOW_SIGNUP = "true";
process.env.SKIP_ENV_VALIDATION = "1";
process.env.UMAMI_ENDPOINT = "";
process.env.UMAMI_WEBSITE_ID = "";
process.env.IS_CLOUD = "";

test("intent parser accepts catalog intent only and never grants capability", () => {
  for (const [product, plan] of [
    ["send", "free"],
    ["send", "choose"],
    ["mail", "choose"],
    ["mail", "free"],
    ["send", "pro_100k"],
    ["mail", "solo"],
    ["mail", "duo"],
    ["mail", "equipe"],
  ]) {
    assert.deepEqual(
      requestedFunnelIntent(
        `mm_funnel_intent=${encodeURIComponent(JSON.stringify({ version: 1, product, plan, team_id: "forged", is_suspected: false }))}`,
      ),
      plan === "choose"
        ? { requested_product: product, requested_selection_state: "unselected" }
        : { requested_product: product, requested_plan: plan },
    );
  }
  for (const value of [
    "",
    "%E0%A4%A",
    "{}",
    '{"version":2,"product":"send","plan":"free"}',
    '{"version":1,"product":"mail","plan":"pro_100k"}',
    '{"version":1,"product":"send","plan":"system"}',
    '{"version":1,"product":"other","plan":"solo"}',
    '{"version":1,"product":"send","plan":{}}',
  ]) {
    assert.deepEqual(requestedFunnelIntent(`mm_funnel_intent=${encodeURIComponent(value)}`), {});
  }
});

test("web funnel suppresses explicit preview and bare loopback without mutating domain rows", async () => {
  const { db, close } = await createTestDb();
  const oldBase = process.env.APP_BASE_URL;
  const oldPreview = process.env.MEPMAIL_LOCAL_PREVIEW;
  try {
    const teamId = await createTeam(db, "guard-fixture");
    for (const [base, preview] of [
      ["https://fixture.invalid", "1"],
      ["http://localhost", ""],
      ["http://127.0.0.1", ""],
      ["http://localhost:3186", ""],
      ["http://127.0.0.1:3186", ""],
    ]) {
      process.env.APP_BASE_URL = base;
      process.env.MEPMAIL_LOCAL_PREVIEW = preview;
      assert.equal(
        await emitFunnel(db, { name: "signup_complete", teamId, dedupeKey: `preview:${base}` }),
        false,
      );
    }
    assert.equal((await db.select().from(schema.funnelEvents)).length, 0);
    assert.equal(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId))).length,
      1,
    );
  } finally {
    if (oldBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oldBase;
    if (oldPreview === undefined) delete process.env.MEPMAIL_LOCAL_PREVIEW;
    else process.env.MEPMAIL_LOCAL_PREVIEW = oldPreview;
    await close();
  }
});

test("real team router commits owner membership then signup once; historical signup key unchanged", async () => {
  const { db, close } = await createTestDb();
  try {
    await db
      .insert(schema.user)
      .values({ id: "caller-user", email: "fixture@example.invalid", name: "Fixture" });
    const caller = teamBootstrapRouter.createCaller({
      db,
      session: { user: { id: "caller-user", email: "fixture@example.invalid", name: "Fixture" } },
      teamId: null,
      role: null,
    } satisfies Context);
    const first = await caller.createTeam({ name: "Fixture one" });
    const second = await caller.createTeam({ name: "Fixture two" });
    await Promise.all([
      trackTeamSignup(db, "caller-user", first.teamId),
      trackTeamSignup(db, "caller-user", second.teamId),
    ]);
    const rows = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, "signup:caller-user"));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]);
    assert.equal(rows[0].teamId, first.teamId);
    assert.equal(rows[0].name, "signup_complete");

    await db
      .insert(schema.user)
      .values({ id: "legacy-user", email: "legacy@example.invalid", name: "Legacy" });
    await db.insert(schema.funnelEvents).values({
      name: "signup_complete",
      dedupeKey: "signup:legacy-user",
      props: { historical: "unchanged" },
    });
    const legacy = teamBootstrapRouter.createCaller({
      db,
      session: { user: { id: "legacy-user", email: "legacy@example.invalid", name: "Legacy" } },
      teamId: null,
      role: null,
    } satisfies Context);
    await legacy.createTeam({ name: "Legacy first" });
    const [old] = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, "signup:legacy-user"));
    assert.ok(old);
    assert.equal(old.teamId, null);
    assert.deepEqual(old.props, { historical: "unchanged" });
  } finally {
    await close();
  }
});

test("real auth signup records account_created without inventing a team", async () => {
  const { db, close } = await createTestDb();
  try {
    const auth = createAuth(db, { send: async () => undefined });
    const response = await auth.handler(
      new Request("https://fixture.invalid/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://fixture.invalid",
          cookie: `mm_funnel_intent=${encodeURIComponent(JSON.stringify({ version: 1, product: "mail", plan: "solo" }))}`,
        },
        body: JSON.stringify({
          name: "Fixture account",
          email: "new@example.invalid",
          password: "Fixture-only!LongPassword123",
        }),
      }),
    );
    assert.equal(response.status, 200, await response.text());
    const users = await db.select().from(schema.user);
    assert.equal(users.length, 1);
    assert.ok(users[0]);
    const rows = await db.select().from(schema.funnelEvents);
    const account = rows.find((r) => r.name === "account_created");
    assert.ok(account);
    assert.equal(account.props?.requested_product, "mail");
    assert.equal(account.props?.requested_plan, "solo");

    assert.equal(account.teamId, null);
    assert.equal(account.dedupeKey, `account:${users[0].id}`);
    assert.ok(!rows.some((r) => r.name === "signup_complete"));

    const caller = teamBootstrapRouter.createCaller({
      db,
      session: { user: users[0] },
      teamId: null,
      role: null,
    } satisfies Context);
    const first = await caller.createTeam({ name: "Mail intent owner" });
    const second = await caller.createTeam({ name: "Mail intent secondary" });
    await trackTeamSignup(db, users[0].id, second.teamId);
    const signups = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, `signup:${users[0].id}`));
    assert.equal(signups.length, 1);
    assert.ok(signups[0]);
    assert.equal(signups[0].teamId, first.teamId);
    assert.equal(signups[0].props?.product, "mail");
    assert.equal(signups[0].props?.requested_product, "mail");
    assert.equal(signups[0].props?.requested_plan, "solo");
    assert.equal(signups[0].props?.bot_status, "unknown");
    assert.equal(signups[0].props?.is_internal, "unknown");
  } finally {
    await close();
  }
});

test("worker provider success only, retry/race/history suppression; no real email", async () => {
  const { db, close } = await createTestDb();
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  try {
    let n = 0;
    async function setup() {
      const teamId = await createTeam(db, `send-fixture-${++n}`);
      const [domain] = await db
        .insert(schema.domains)
        .values({
          teamId,
          name: `fixture${n}.invalid`,
          region: "us-east-1",
          status: "verified",
          verifiedAt: new Date(),
        })
        .returning();
      assert.ok(domain);
      return { teamId, domainId: domain.id };
    }
    async function email(
      t: { teamId: string; domainId: string },
      extra: Partial<typeof schema.emails.$inferInsert> = {},
    ) {
      const body = await encryptEmailBody({ html: "<b>fixture</b>", text: "fixture" }, keyring);
      const [e] = await db
        .insert(schema.emails)
        .values({
          ...t,
          from: `sender@fixture${n}.invalid`,
          to: ["recipient@example.invalid"],
          subject: "Fixture",
          latestStatus: "queued",
          bodyCiphertext: body.ciphertext,
          bodyIv: body.iv,
          bodyWrappedDek: body.wrappedDek,
          bodyKeyVersion: body.keyVersion,
          ...extra,
        })
        .returning();
      assert.ok(e);
      return e.id;
    }
    const send = async (
      _t: { teamId: string; domainId: string },
      id: string,
      ses: SesSender = { sendRaw: async () => ({ messageId: `mock-${id}` }) },
    ) => sendEmail(db, { keyring, ses, funnel: target, isCloud: true }, { emailId: id });
    const queued = await setup();
    const queuedIds: string[] = [];
    const accepted = await acceptEmail(
      {
        db,
        keyring,
        isCloud: false,
        enqueueEmailSend: async (id) => {
          queuedIds.push(id);
        },
        funnel: target,
      },
      { teamId: queued.teamId, billing: "uncapped", apiKeyId: null },
      {
        from: `sender@fixture${n}.invalid`,
        to: ["recipient@example.invalid"],
        subject: "Fixture queue only",
        text: "fixture",
        domainId: queued.domainId,
      },
    );
    assert.equal(accepted.ok, true);
    assert.equal(queuedIds.length, 1);
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.teamId, queued.teamId))
      ).length,
      0,
    );

    const sandbox = await setup();
    await db.insert(schema.user).values({
      id: "sandbox-principal",
      name: "Fixture sandbox",
      email: "recipient@example.invalid",
      emailVerified: true,
    });
    await db.insert(schema.teamSignupRisk).values({
      teamId: sandbox.teamId,
      principalUserId: "sandbox-principal",
      level: "sandbox",
      signals: {
        domain: "example.invalid",
        disposable: false,
        mx: "unknown",
        domainAgeDays: null,
        catchAll: "unknown",
        randomLocal: false,
        ipKey: null,
        asn: null,
        signupsIp1h: 0,
        signupsDomain24h: 0,
        signupsAsn1h: 0,
      },
    });
    const sandboxId = await email(sandbox);
    assert.equal(await send(sandbox, sandboxId), "sent");
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.teamId, sandbox.teamId))
      ).length,
      0,
    );

    const t = await setup(),
      id = await email(t);
    assert.equal(await send(t, id), "sent");
    assert.equal(await send(t, id), "skipped");
    let rows = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, `first_send:${t.teamId}`));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]);

    for (const collectorMode of ["unavailable", "throwing"] as const) {
      const isolated = await setup();
      const emailId = await email(isolated);
      let collectorCalls = 0;
      const collector: FunnelEventTarget = {
        ...target,
        fetch: async () => {
          collectorCalls++;
          const [stored] = await db
            .select()
            .from(schema.emails)
            .where(eq(schema.emails.id, emailId));
          assert.ok(stored);
          assert.equal(stored.sesMessageId, `mock-${emailId}`);
          assert.equal(stored.latestStatus, "sent");
          const usage = await db
            .select()
            .from(schema.usageCounters)
            .where(eq(schema.usageCounters.teamId, isolated.teamId));
          assert.equal(
            usage.reduce((sum, row) => sum + row.sent, 0),
            1,
          );

          if (collectorMode === "throwing") throw new Error("fixture-collector-unavailable");
          return new Response(null, { status: 503 });
        },
      };
      assert.equal(
        await sendEmail(
          db,
          {
            keyring,
            ses: { sendRaw: async () => ({ messageId: `mock-${emailId}` }) },
            funnel: collector,
            isCloud: true,
          },
          { emailId },
        ),
        "sent",
      );
      assert.equal(collectorCalls, 1);
      const [stored] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
      assert.ok(stored);
      assert.equal(stored.sesMessageId, `mock-${emailId}`);
      assert.equal(stored.latestStatus, "sent");
      const domain = await db
        .select()
        .from(schema.domains)
        .where(eq(schema.domains.id, isolated.domainId));
      assert.ok(domain[0]);
      assert.equal(domain[0].status, "verified");
      const ledger = await db
        .select()
        .from(schema.funnelEvents)
        .where(eq(schema.funnelEvents.dedupeKey, `first_send:${isolated.teamId}`));
      assert.equal(ledger.length, 1);
      assert.equal(await send(isolated, emailId), "skipped");
    }
    const t2 = await setup();
    const failed = await email(t2);
    assert.equal(
      await send(t2, failed, {
        sendRaw: async () => {
          throw Object.assign(new Error("mock rejection"), { name: "MessageRejected" });
        },
      }),
      "failed",
    );
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, t2.teamId)))
        .length,
      0,
    );

    const t3 = await setup();
    await db.insert(schema.usageCounters).values({ teamId: t3.teamId, day: "2020-01-01", sent: 1 });
    const old = await email(t3);
    assert.equal(await send(t3, old), "sent");
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, t3.teamId)))
        .length,
      0,
    );

    const t4 = await setup();
    await db.insert(schema.funnelEvents).values({
      teamId: t4.teamId,
      name: "first_email_sent",
      dedupeKey: `first_email_sent:${t4.teamId}`,
    });
    const [a, b] = await Promise.all([email(t4), email(t4)]);
    await Promise.all([send(t4, a), send(t4, b)]);
    rows = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, `first_send:${t4.teamId}`));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]);

    const held = await setup();
    await db
      .update(schema.teams)
      .set({
        sendReviewAt: new Date(),
        sendReviewReason: "new_sender",
        sendReviewNote: "Fixture-only review hold",
      })
      .where(eq(schema.teams.id, held.teamId));
    const heldId = await email(held);
    assert.equal(await send(held, heldId), "parked");
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.teamId, held.teamId))
      ).length,
      0,
    );

    for (const status of ["canceled", "failed", "sent"] as const) {
      const tx = await setup();
      const id = await email(tx, { latestStatus: status });
      assert.equal(await send(tx, id), "skipped");
      assert.equal(
        (
          await db
            .select()
            .from(schema.funnelEvents)
            .where(eq(schema.funnelEvents.teamId, tx.teamId))
        ).length,
        0,
      );
    }
  } finally {
    await close();
  }
});

test("verified live paid acquisition only; positive fake is NOT a real Stripe charge", async () => {
  const { db, close } = await createTestDb();
  const { stripe, state } = fakeStripe();
  try {
    const teamId = await createTeam(db, "billing-fixture");
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_funnel" })
      .where(eq(schema.teams.id, teamId));
    const attemptId = randomUUID();
    const sub = subscription("sub_funnel", "cus_funnel", "active", "millionsend_pro_100k_monthly", {
      overageKey: "millionsend_pro_100k_overage",
    });
    sub.livemode = true;
    sub.metadata = { ...sub.metadata, mepmail_send_checkout: attemptId };
    state.subscriptions.sub_funnel = sub;
    // The original financial intent is persisted, not manufactured from the invoice.
    await db.insert(schema.sendCheckoutAttempts).values({
      id: attemptId,
      teamId,
      createdBy: null,
      rung: "pro_100k",
      livemode: true,
      stripeCustomerId: "cus_funnel",
      parameters: { line_items: sub.items.data.map((i) => ({ price: i.price.id })) },
      idempotencyKey: "fixture",
      status: "prepared",
    });
    const now = Math.floor(Date.now() / 1000);
    const invoice = {
      id: "in_fixture",
      object: "invoice",
      customer: "cus_funnel",
      parent: { subscription_details: { subscription: "sub_funnel" } },
      status: "paid",
      billing_reason: "subscription_create",
      currency: "usd",
      amount_paid: 2000,
      livemode: true,
      status_transitions: { paid_at: now },
      lines: {
        has_more: false,
        data: sub.items.data.map((i) => ({
          pricing: { price_details: { price: i.price.id } },
          parent: { subscription_item_details: { proration: false } },
        })),
      },
    };
    let seq = 0;
    async function deliver(
      v: unknown,
      type = "invoice.payment_succeeded",
      mode = true,
      bad = false,
    ) {
      const payload = JSON.stringify({
        id: `evt_fixture_${++seq}`,
        type,
        livemode: mode,
        created: now,
        data: { object: v },
      });
      return handleWebhook(
        payload,
        bad ? "bad" : webhooks.generateTestHeaderString({ payload, secret: "whsec_fixture" }),
        { db, stripe, webhookSecret: "whsec_fixture", livemode: mode, funnel: target },
      );
    }
    for (const change of [
      { amount_paid: 0 },
      { billing_reason: "subscription_cycle" },
      { livemode: false },
      { currency: "xxx" },
    ]) {
      assert.equal(await deliver({ ...invoice, ...change }), 200);
      assert.equal(
        (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, teamId)))
          .length,
        0,
      );
    }
    assert.equal(await deliver(invoice, "invoice.payment_succeeded", true, true), 400);

    assert.equal(await deliver(invoice, "invoice.payment_succeeded", false), 200);
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, teamId)))
        .length,
      0,
    );

    sub.trial_start = now - 100;
    sub.trial_end = now + 100;
    await deliver(invoice);
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, teamId)))
        .length,
      0,
    );
    sub.trial_start = null;
    sub.trial_end = null;

    sub.metadata.mepmail_service = "mailbox";
    await deliver(invoice);
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, teamId)))
        .length,
      0,
    );
    delete sub.metadata.mepmail_service;

    assert.equal(await deliver(invoice, "invoice.paid"), 200);
    assert.equal(
      (await db.select().from(schema.funnelEvents).where(eq(schema.funnelEvents.teamId, teamId)))
        .length,
      0,
    );

    assert.equal(await deliver(invoice), 200);
    const rows = await db
      .select()
      .from(schema.funnelEvents)
      .where(eq(schema.funnelEvents.dedupeKey, `subscription_paid:${teamId}`));
    assert.equal(rows.length, 1);
    assert.ok(rows[0]);
    assert.equal(rows[0].name, "subscription_paid");

    // Deliberately partial SDK transport fixture; production caller and signature verification remain real.
    stripe.invoices = {
      retrieve: async (id: string, params?: Stripe.InvoiceRetrieveParams) => {
        assert.deepEqual(params, { expand: ["payments.data.payment.payment_intent"] });

        assert.ok(id.startsWith("in_"));

        return {
          ...invoice,
          payments: {
            has_more: false,
            data: [
              {
                status: "paid",
                payment: {
                  type: "payment_intent",
                  payment_intent: {
                    id: "pi_fixture",
                    livemode: true,
                    status: "succeeded",
                    currency: "usd",
                    amount_received: 2000,
                    customer: "cus_funnel",
                  },
                },
              },
            ],
          },
        } as unknown as Stripe.Invoice;
      },
    } satisfies NonNullable<BillingStripe["invoices"]>;
    assert.equal(await deliver(invoice, "invoice.paid"), 200);

    await Promise.all([deliver(invoice), deliver(invoice, "invoice.paid")]);
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.dedupeKey, `subscription_paid:${teamId}`))
      ).length,
      1,
    );

    // invoice.paid also works as the FIRST alias, but only with canonical captured-money proof.
    const aliasTeam = await createTeam(db, "billing-alias-fixture"),
      aliasAttempt = randomUUID();
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_alias" })
      .where(eq(schema.teams.id, aliasTeam));
    const aliasSub = subscription(
      "sub_alias",
      "cus_alias",
      "active",
      "millionsend_pro_100k_monthly",
      { overageKey: "millionsend_pro_100k_overage" },
    );
    aliasSub.livemode = true;
    aliasSub.metadata = { mepmail_send_checkout: aliasAttempt };
    state.subscriptions.sub_alias = aliasSub;
    await db.insert(schema.sendCheckoutAttempts).values({
      id: aliasAttempt,
      teamId: aliasTeam,
      createdBy: null,
      rung: "pro_100k",
      livemode: true,
      stripeCustomerId: "cus_alias",
      parameters: { line_items: aliasSub.items.data.map((i) => ({ price: i.price.id })) },
      idempotencyKey: "fixture-alias",
      status: "prepared",
    });
    const aliasInvoice = {
      ...invoice,
      id: "in_alias",
      // This attempt was created later than the first invoice's attempt; keep its own
      // payment timestamp within the real acquisition lineage window, not fixture wall-time drift.
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      customer: "cus_alias",
      parent: { subscription_details: { subscription: "sub_alias" } },
    };
    // Deliberately partial SDK transport fixture; production caller and signature verification remain real.
    stripe.invoices = {
      retrieve: async (id: string, params?: Stripe.InvoiceRetrieveParams) => {
        assert.deepEqual(params, { expand: ["payments.data.payment.payment_intent"] });

        assert.ok(id.startsWith("in_"));

        return {
          ...aliasInvoice,
          payments: {
            has_more: false,
            data: [
              {
                status: "paid",
                payment: {
                  type: "payment_intent",
                  payment_intent: {
                    id: "pi_alias",
                    livemode: true,
                    status: "succeeded",
                    currency: "usd",
                    amount_received: 2000,
                    customer: "cus_alias",
                  },
                },
              },
            ],
          },
        } as unknown as Stripe.Invoice;
      },
    } satisfies NonNullable<BillingStripe["invoices"]>;
    const expandedRetrieve: (
      id: string,
      params?: Stripe.InvoiceRetrieveParams,
    ) => Promise<Stripe.Invoice> = stripe.invoices.retrieve;
    stripe.invoices.retrieve = async (id, params) => {
      const expanded = await expandedRetrieve(id, params);
      // Deliberate malformed/partial negative SDK fixture: an ID is not captured money.
      const idOnly = {
        ...expanded,
        payments: {
          has_more: false,
          data: [
            { status: "paid", payment: { type: "payment_intent", payment_intent: "pi_alias" } },
          ],
        },
      };
      return idOnly as unknown as Stripe.Invoice;
    };
    assert.equal(await deliver(aliasInvoice, "invoice.paid"), 200);
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.dedupeKey, `subscription_paid:${aliasTeam}`))
      ).length,
      0,
    );

    stripe.invoices.retrieve = expandedRetrieve;
    assert.equal(await deliver(aliasInvoice, "invoice.paid"), 200);
    assert.equal(
      (
        await db
          .select()
          .from(schema.funnelEvents)
          .where(eq(schema.funnelEvents.dedupeKey, `subscription_paid:${aliasTeam}`))
      ).length,
      1,
    );
  } finally {
    await close();
  }
});
test("actual web POST forwards the configured collector to the billing transport", async () => {
  const { db, close } = await createTestDb();
  const oldCloud = process.env.IS_CLOUD;
  const oldEndpoint = process.env.UMAMI_ENDPOINT;
  const oldWebsite = process.env.UMAMI_WEBSITE_ID;
  const oldKey = process.env.STRIPE_SECRET_KEY;
  const { stripe } = fakeStripe();
  try {
    process.env.IS_CLOUD = "true";
    process.env.UMAMI_ENDPOINT = "https://collector.fixture.invalid";
    process.env.UMAMI_WEBSITE_ID = "fixture-web-route";
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture_literal_not_a_real_key";
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    vi.spyOn(webBillingModule, "getStripe").mockReturnValue(stripe);
    const transport = vi
      .spyOn(billingModule, "handleWebhook")
      .mockImplementation(async (body, signature, deps) => {
        assert.equal(body, "{}");
        assert.equal(signature, "fixture-signature");
        assert.equal(deps.db, db);
        assert.equal(deps.stripe, stripe);
        assert.equal(deps.funnel?.endpoint, "https://collector.fixture.invalid");
        assert.equal(deps.funnel?.websiteId, "fixture-web-route");
        assert.equal(deps.funnel?.hostname, "fixture.invalid");

        return 400;
      });
    const { POST } = await import("../src/app/api/billing/webhook/route.js");
    const response = await POST(
      new Request("https://fixture.invalid/api/billing/webhook", {
        method: "POST",
        headers: { "stripe-signature": "fixture-signature" },
        body: "{}",
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(transport.mock.calls.length, 1);
    assert.equal((await db.select().from(schema.funnelEvents)).length, 0);
  } finally {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries({
      IS_CLOUD: oldCloud,
      UMAMI_ENDPOINT: oldEndpoint,
      UMAMI_WEBSITE_ID: oldWebsite,
      STRIPE_SECRET_KEY: oldKey,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await close();
  }
});

afterAll(() =>
  console.log(
    JSON.stringify({
      fixture_assertions_completed: checks,
      external_network: "blocked",
      real_charge_proven: false,
    }),
  ),
);
