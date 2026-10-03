import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMailboxCustomer } from "../src/mailbox-lifecycle.js";
import { beginSendCheckout, SEND_CHECKOUT_METADATA_KEY } from "../src/send-checkout.js";
import { subscription } from "./helpers.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
beforeEach(async () => {
  f = await checkoutFixture();
});
afterEach(async () => {
  await f.close();
});
const attempt = async () => (await f.db.select().from(schema.sendCheckoutAttempts))[0]!;

describe("durable Send checkout", () => {
  it("reuses one Customer and Session across retries with a stale caller team snapshot", async () => {
    const first = await beginSendCheckout(f.deps, f.input);
    const second = await beginSendCheckout(f.deps, f.input);
    expect(second).toEqual(first);
    expect(f.posts.filter((p) => p.kind === "customer")).toHaveLength(1);
    expect(f.posts.filter((p) => p.kind === "session")).toHaveLength(1);
    expect((await attempt()).status).toBe("created");
  });
  it.each([
    { rung: "pro_200k" as const },
    { successUrl: "https://app/different" },
    { cancelUrl: "https://app/different" },
    { automaticTax: true },
  ])("freezes financial intent when parameters change: %j", async (patch) => {
    await beginSendCheckout(f.deps, f.input);
    await expect(beginSendCheckout(f.deps, { ...f.input, ...patch })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.sessions.size).toBe(1);
  });
  it("keeps an ambiguous Customer blocked instead of creating a second one", async () => {
    f.loseCustomer();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    f.loseCustomer(false);
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    expect(f.posts).toHaveLength(1);
    expect(f.customers.size).toBe(1);
    expect(f.sessions.size).toBe(0);
    expect((await f.db.select().from(schema.mailboxCustomerRequests))[0]?.status).toBe("creating");
  });
  it("resolves a lost Customer using the existing Mail snapshot readback contract", async () => {
    f.loseCustomer();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    await resolveMailboxCustomer(
      { db: f.db, stripe: f.stripe, livemode: false },
      { teamId: f.input.team.id, userId: f.input.userId, knownCustomerId: "cus_1" },
    );
    f.loseCustomer(false);
    await beginSendCheckout(f.deps, f.input);
    expect(f.customers.size).toBe(1);
    expect(f.posts.filter((p) => p.kind === "customer")).toHaveLength(1);
  });
  it("honors an ambiguous shared Mail Customer claim without another Customer POST", async () => {
    await f.db.insert(schema.mailboxCustomerRequests).values({
      teamId: f.input.team.id,
      createdBy: f.input.userId,
      status: "creating",
      name: "acme",
      email: f.input.email,
      livemode: false,
      idempotencyKey: "mailbox-customer-existing-unknown",
    });
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    expect(f.posts).toEqual([]);
  });
  it("replays a lost Session response with exactly the same key and parameters across minutes", async () => {
    f.loseSession();
    f.hideSessions();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    const before = await attempt();
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({ firstRequestedAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.sendCheckoutAttempts.id, before.id));
    f.stripe.prices.list = async () => {
      throw new Error("rotated catalog must not replace frozen intent");
    };
    f.loseSession(false);
    await beginSendCheckout(f.deps, f.input);
    const posts = f.posts.filter((p) => p.kind === "session");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(f.sessions.size).toBe(1);
  });
  it("does not resolve unknown by lease expiry or replay an old idempotency key", async () => {
    f.loseSession();
    f.hideSessions();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    const row = await attempt();
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({
        firstRequestedAt: new Date(Date.now() - 24 * 3600_000),
        leaseUntil: null,
        leaseToken: null,
      })
      .where(eq(schema.sendCheckoutAttempts.id, row.id));
    f.loseSession(false);
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    expect(f.posts.filter((p) => p.kind === "session")).toHaveLength(1);
    expect((await attempt()).status).toBe("unknown");
  });
  it("recovers an old unknown by correlated authoritative readback without another POST", async () => {
    f.loseSession();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    const row = await attempt();
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({ firstRequestedAt: new Date(Date.now() - 48 * 3600_000) })
      .where(eq(schema.sendCheckoutAttempts.id, row.id));
    const recovered = await beginSendCheckout(f.deps, f.input);
    expect(recovered.stripeSessionId).toBe("cs_1");
    expect(f.posts.filter((p) => p.kind === "session")).toHaveLength(1);
  });
  it("an active lease blocks another provider attempt", async () => {
    await beginSendCheckout(f.deps, f.input);
    const row = await attempt();
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({
        leaseToken: "00000000-0000-4000-8000-000000000001",
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .where(eq(schema.sendCheckoutAttempts.id, row.id));
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    expect(f.sessions.size).toBe(1);
  });
  it("prevents another open attempt with the actual partial unique constraint", async () => {
    await beginSendCheckout(f.deps, f.input);
    const row = await attempt();
    await expect(
      f.db.insert(schema.sendCheckoutAttempts).values({
        teamId: row.teamId,
        status: "prepared",
        rung: row.rung,
        livemode: false,
        stripeCustomerId: row.stripeCustomerId,
        idempotencyKey: "different",
        parameters: {},
      }),
    ).rejects.toThrow();
  });
  it("checks current membership before retrying a financial intent", async () => {
    f.loseSession();
    f.hideSessions();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    await f.db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.userId, f.input.userId));
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.posts.filter((p) => p.kind === "session")).toHaveLength(1);
  });
  it("blocks incomplete Send subscription before even creating a Customer", async () => {
    await f.db
      .update(schema.teams)
      .set({ planStatus: "incomplete", stripeSubscriptionId: "sub_pending" })
      .where(eq(schema.teams.id, f.input.team.id));
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({
      code: "subscription_exists",
    });
    expect(f.posts).toEqual([]);
  });
  it("a provider-proven expired Session closes the old intent before the next one", async () => {
    await beginSendCheckout(f.deps, f.input);
    f.sessions.values().next().value!.status = "expired";
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "expired" });
    expect((await attempt()).status).toBe("resolved");
    await beginSendCheckout(f.deps, f.input);
    expect(f.customers.size).toBe(1);
    expect(f.sessions.size).toBe(2);
  });
  it("complete cannot grant access or permit another purchase while fulfillment is pending", async () => {
    await beginSendCheckout(f.deps, f.input);
    const session = f.sessions.values().next().value!;
    session.status = "complete";
    session.subscription = "sub_pending";
    // The list snapshot is still empty, while the correlated retrieve sees completion.
    // Keep the real Subscription item/Price shape: omitting it is malformed evidence.
    f.stripe.subscriptions.retrieve = async (id) => {
      expect(id).toBe(session.subscription);
      return {
        ...subscription("sub_pending", session.customer as string, "incomplete"),
        livemode: false,
        metadata: session.metadata ?? {},
      };
    };
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    expect((await f.db.select().from(schema.teams))[0]?.plan).toBe("free");
    expect(f.sessions.size).toBe(1);
  });
  it("requires terminal subscription readback before replacing a completed Session", async () => {
    await beginSendCheckout(f.deps, f.input);
    const session = f.sessions.values().next().value!;
    session.status = "complete";
    session.subscription = "sub_canceled";
    f.stripe.subscriptions.retrieve = async (id) => {
      expect(id).toBe(session.subscription);
      return {
        ...subscription("sub_canceled", session.customer as string, "canceled"),
        livemode: false,
        metadata: session.metadata ?? {},
      };
    };
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "expired" });
    await beginSendCheckout(f.deps, f.input);
    expect(f.customers.size).toBe(1);
    expect(f.sessions.size).toBe(2);
  });
  it("does not adopt an unrelated open legacy Session as a new financial attempt", async () => {
    await beginSendCheckout(f.deps, f.input);
    const row = await attempt();
    await f.db
      .update(schema.sendCheckoutAttempts)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(schema.sendCheckoutAttempts.id, row.id));
    f.sessions.values().next().value!.metadata = {};
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "pending" });
    expect(f.sessions.size).toBe(1);
  });
  it("rejects mismatched correlated readback instead of issuing another Session", async () => {
    f.loseSession();
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    const session = f.sessions.values().next().value!;
    expect(session.metadata?.[SEND_CHECKOUT_METADATA_KEY]).toBe((await attempt()).id);
    session.client_reference_id = "other-team";
    await expect(beginSendCheckout(f.deps, f.input)).rejects.toMatchObject({ code: "unknown" });
    expect(f.sessions.size).toBe(1);
  });
});
