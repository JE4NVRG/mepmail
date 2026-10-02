import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MailboxErasureStripe, withMailboxTeamErasure } from "../src/mailbox-erasure.js";
import { subscription } from "./helpers.js";

const CUSTOMER = "cus_erasure_fixture";
const OWNER = "owner_erasure_fixture";
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
let db: Db, close: () => Promise<void>, teamId: string, stripe: MailboxErasureStripe;
let calls: string[],
  subscriptions: Map<string, Stripe.Subscription>,
  sessions: Map<string, Stripe.Checkout.Session>;
let subscriptionPages: Stripe.Subscription[][] | null, failExpire: boolean, failCancel: boolean;
const team = async () =>
  (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];
const plan = async () =>
  (
    await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
  )[0];
const leases = () =>
  db.select().from(schema.mailboxCheckouts).where(eq(schema.mailboxCheckouts.teamId, teamId));
function sub(
  id: string,
  mail = true,
  status: Stripe.Subscription.Status = "active",
  customer = CUSTOMER,
) {
  const value = subscription(id, customer, status);
  value.livemode = false;
  value.metadata = mail ? { mepmail_service: "mailbox" } : {};
  subscriptions.set(id, value);
  return value;
}
async function seedPlan(id = "sub_linked_mail") {
  sub(id);
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    stripeCustomerId: CUSTOMER,
    stripeSubscriptionId: id,
    storageBytesPerMailbox: 4096,
    includedOutboundPerMailbox: 7,
    livemode: false,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
}
async function seedLease(status: "ready" | "creating" = "ready") {
  const [lease] = await db
    .insert(schema.mailboxCheckouts)
    .values({
      teamId,
      createdBy: OWNER,
      status,
      stripeCustomerId: CUSTOMER,
      stripePriceId: "price_erasure_fixture",
      seats: 2,
      livemode: false,
      idempotencyKey: "mailbox:erasure:" + teamId,
      currency: "usd",
      unitAmount: 123,
      interval: "month",
      storageBytesPerMailbox: 4096,
      includedOutboundPerMailbox: 7,
      successUrl: "https://example.invalid/success",
      cancelUrl: "https://example.invalid/cancel",
      stripeSessionId: status === "ready" ? "cs_ready_fixture" : null,
      checkoutUrl: status === "ready" ? "https://checkout.example.invalid/ready" : null,
      createdAt: new Date(0),
    })
    .returning();
  if (!lease) throw new Error("Missing fixture lease");
  return lease;
}
function session(
  id: string,
  key: string,
  status: Stripe.Checkout.Session.Status = "open",
  subscriptionId: string | null = null,
) {
  const value = {
    id,
    object: "checkout.session",
    mode: "subscription",
    customer: CUSTOMER,
    livemode: false,
    status,
    subscription: subscriptionId,
    url: "https://checkout.example.invalid/ready",
    metadata: { team_id: teamId, mepmail_service: "mailbox", mepmail_checkout_key: key },
  } as unknown as Stripe.Checkout.Session;
  sessions.set(id, value);
  return value;
}
function page<T>(data: T[], hasMore = false): Stripe.ApiList<T> {
  return { object: "list", data, has_more: hasMore, url: "/v1/synthetic" };
}
const remove = async (tx: Db) => {
  calls.push("delete");
  await tx.delete(schema.teams).where(eq(schema.teams.id, teamId));
  return { teamId };
};
const cancelSend = async (_tx: Db, id: string) => {
  calls.push("cancelSend:" + id);
};
const erase = (
  callbacks: Parameters<typeof withMailboxTeamErasure<{ teamId: string }>>[2] = {
    cancelSend,
    delete: remove,
  },
) => withMailboxTeamErasure({ db, stripe, livemode: false }, { teamId, userId: OWNER }, callbacks);

beforeEach(async () => {
  // The root qualifies the main baseline through 0042; Mail migrations remain independent.
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((part) => part.trim()))
      await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "erasure-fixture");
  await db.insert(schema.user).values({ id: OWNER, name: "Owner", email: "owner@example.invalid" });
  await db.insert(schema.teamMembers).values({ teamId, userId: OWNER, role: "owner" });
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: CUSTOMER, stripeSubscriptionId: "sub_send" })
    .where(eq(schema.teams.id, teamId));
  calls = [];
  subscriptions = new Map();
  sessions = new Map();
  subscriptionPages = null;
  failExpire = false;
  failCancel = false;
  sub("sub_send", false);
  stripe = {
    subscriptions: {
      async retrieve(id) {
        calls.push("retrieve:" + id);
        const found = subscriptions.get(id);
        if (!found) throw new Error("Synthetic provider unavailable");
        return found;
      },
      async list(params) {
        calls.push("list:" + (params.starting_after ?? "first"));
        expect(params.customer).toBe(CUSTOMER);
        expect(params.status).toBe("all");
        if (!subscriptionPages) return page([...subscriptions.values()]);
        const index = params.starting_after
          ? subscriptionPages.findIndex((values) => values.at(-1)?.id === params.starting_after) + 1
          : 0;
        return page(subscriptionPages[index] ?? [], index < subscriptionPages.length - 1);
      },
      async cancel(id, params) {
        calls.push("cancel:" + id);
        expect(params).toEqual({ invoice_now: false, prorate: false });
        if (failCancel) throw new Error("Synthetic cancellation ambiguous");
        const found = subscriptions.get(id);
        if (!found) throw new Error("Missing synthetic subscription");
        found.status = "canceled";
        return found;
      },
    },
    checkout: {
      sessions: {
        async retrieve(id) {
          calls.push("session:" + id);
          const found = sessions.get(id);
          if (!found) throw new Error("Synthetic session unavailable");
          return found;
        },
        async list(params) {
          calls.push("sessions.list");
          expect(params.customer).toBe(CUSTOMER);
          return page([...sessions.values()]);
        },
        async expire(id) {
          calls.push("expire:" + id);
          if (failExpire) throw new Error("Synthetic expiration ambiguous");
          const found = sessions.get(id);
          if (!found || found.status !== "open") throw new Error("Session cannot expire");
          found.status = "expired";
          found.url = null;
          return found;
        },
      },
    },
  };
});
afterEach(async () => {
  await close();
});

describe("safe Mail cancellation before team erasure", () => {
  it("expires exposed URLs, discovers paginated Mail and linked IDs, then runs Send/delete under the locks", async () => {
    await seedPlan("sub_linked_without_tag");
    subscriptions.get("sub_linked_without_tag")!.metadata = {};
    const lease = await seedLease();
    session("cs_ready_fixture", lease.idempotencyKey);
    const discovered = sub("sub_discovered_mail");
    const unrelated = sub("sub_other_product", false);
    subscriptionPages = [[subscriptions.get("sub_send")!, unrelated], [discovered]];
    expect(
      await erase({
        cancelSend: async (tx, id) => {
          expect((await tx.select().from(schema.mailboxCheckouts))[0]).toMatchObject({
            status: "expired",
            checkoutUrl: null,
          });
          expect((await tx.select().from(schema.mailboxSubscriptions))[0]).toMatchObject({
            status: "canceled",
            stripeSubscriptionId: "sub_linked_without_tag",
          });
          await cancelSend(tx, id);
        },
        delete: remove,
      }),
    ).toEqual({ teamId });
    expect(calls.indexOf("expire:cs_ready_fixture")).toBeLessThan(
      calls.indexOf("cancelSend:" + teamId),
    );
    expect(calls.filter((value) => value.startsWith("cancel:"))).toEqual([
      "cancel:sub_discovered_mail",
      "cancel:sub_linked_without_tag",
    ]);
    expect(calls).toContain("list:sub_other_product");
    expect(subscriptions.get("sub_send")!.status).toBe("active");
    expect(unrelated.status).toBe("active");
    expect(await team()).toBeUndefined();
    expect(await leases()).toHaveLength(0);
    expect(stripe).not.toHaveProperty("customers");
  });
  it("keeps a creating checkout pending when unique readback is absent or duplicated, even without a TTL", async () => {
    await seedPlan();
    const lease = await seedLease("creating");
    await expect(erase()).rejects.toMatchObject({ code: "pending" });
    session("cs_first", lease.idempotencyKey);
    session("cs_second", lease.idempotencyKey);
    await expect(erase()).rejects.toMatchObject({ code: "pending" });
    expect(await team()).toBeDefined();
    expect((await leases())[0]).toMatchObject({ status: "creating", stripeSessionId: null });
    expect((await plan())!.status).toBe("active");
    expect(
      calls.some(
        (value) =>
          value.startsWith("expire:") ||
          value.startsWith("cancel:") ||
          value.startsWith("cancelSend:") ||
          value === "delete",
      ),
    ).toBe(false);
  });
  it("recovers a completed checkout only for cancellation and never grants entitlement from its URL", async () => {
    const lease = await seedLease("creating");
    session("cs_completed", lease.idempotencyKey, "complete", "sub_completed_mail");
    sub("sub_completed_mail");
    await erase({
      delete: async (tx) => {
        expect(await tx.select().from(schema.mailboxSubscriptions)).toHaveLength(0);
        expect((await tx.select().from(schema.mailboxCheckouts))[0]).toMatchObject({
          status: "completed",
          stripeSessionId: "cs_completed",
          stripeSubscriptionId: "sub_completed_mail",
          checkoutUrl: null,
        });
        return remove(tx);
      },
    });
    expect(calls).toContain("cancel:sub_completed_mail");
    expect(calls.some((value) => value.startsWith("expire:"))).toBe(false);
  });
  it("pins the expired Session ID and resolves a completion racing URL expiration by readback", async () => {
    const lease = await seedLease();
    const ready = session("cs_ready_fixture", lease.idempotencyKey);
    stripe.checkout.sessions.expire = async () => ({
      ...ready,
      id: "cs_wrong_response",
      status: "expired",
    });
    await expect(erase()).rejects.toMatchObject({ code: "conflict" });
    expect(await team()).toBeDefined();
    expect(calls).not.toContain("cancelSend:" + teamId);
    sub("sub_completion_race");
    stripe.checkout.sessions.expire = async () => {
      ready.status = "complete";
      ready.subscription = "sub_completion_race";
      throw new Error("Synthetic completion won the expiration race");
    };
    await erase();
    expect(calls).toContain("cancel:sub_completion_race");
    expect(calls.filter((value) => value === "session:cs_ready_fixture")).toHaveLength(3);
    expect(await team()).toBeUndefined();
  });
  it("preserves all DB rows after ambiguous expiration/cancellation and safely retries confirmed terminal facts", async () => {
    await seedPlan();
    const lease = await seedLease();
    session("cs_ready_fixture", lease.idempotencyKey);
    failExpire = true;
    await expect(erase()).rejects.toMatchObject({ code: "pending" });
    expect((await leases())[0]!.status).toBe("ready");
    failExpire = false;
    failCancel = true;
    await expect(erase()).rejects.toMatchObject({ code: "pending" });
    expect(await team()).toBeDefined();
    expect((await plan())!.status).toBe("active");
    expect((await leases())[0]!.status).toBe("ready");
    expect(calls).not.toContain("delete");
    expect(calls).not.toContain("cancelSend:" + teamId);
    failCancel = false;
    await erase();
    expect(calls.filter((value) => value.startsWith("expire:"))).toHaveLength(2);
    expect(await team()).toBeUndefined();
  });
  it("does not replay already canceled subscriptions, and rollback retains evidence for a failed callback", async () => {
    await seedPlan();
    const lease = await seedLease();
    session("cs_ready_fixture", lease.idempotencyKey);
    await expect(
      erase({
        cancelSend: async () => {
          throw new Error("Synthetic Send cancellation unavailable");
        },
        delete: remove,
      }),
    ).rejects.toThrow("Synthetic Send cancellation unavailable");
    expect(await team()).toBeDefined();
    expect((await plan())!.status).toBe("active");
    expect((await leases())[0]!.status).toBe("ready");
    expect(subscriptions.get("sub_linked_mail")!.status).toBe("canceled");
    sub("sub_incomplete_expired", true, "incomplete_expired");
    await erase();
    expect(calls.filter((value) => value === "cancel:sub_linked_mail")).toHaveLength(1);
    expect(calls).not.toContain("cancel:sub_incomplete_expired");
    expect(calls.filter((value) => value.startsWith("expire:"))).toHaveLength(1);
  });
  it("rejects Customer/mode/provider identity mismatches before canceling Mail, Send or deleting", async () => {
    await seedPlan();
    subscriptions.get("sub_linked_mail")!.customer = "cus_other";
    await expect(erase()).rejects.toMatchObject({ code: "conflict" });
    subscriptions.get("sub_linked_mail")!.customer = CUSTOMER;
    subscriptions.get("sub_linked_mail")!.livemode = true;
    await expect(erase()).rejects.toMatchObject({ code: "conflict" });
    subscriptions.get("sub_linked_mail")!.livemode = false;
    await db
      .update(schema.mailboxSubscriptions)
      .set({ stripeCustomerId: "cus_other" })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(erase()).rejects.toMatchObject({ code: "conflict" });
    await db
      .update(schema.mailboxSubscriptions)
      .set({ stripeCustomerId: CUSTOMER })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    sub("sub_wrong_customer", true, "active", "cus_other");
    await expect(erase()).rejects.toMatchObject({ code: "conflict" });
    expect(
      calls.some(
        (value) =>
          value.startsWith("cancel:") || value.startsWith("cancelSend:") || value === "delete",
      ),
    ).toBe(false);
    expect(await team()).toBeDefined();
  });
  it("uses the current owner membership and deletes a clean unlinked team without any Stripe factory", async () => {
    const getStripe = vi.fn(() => stripe);
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await expect(
      withMailboxTeamErasure(
        { db, getStripe, livemode: false },
        { teamId, userId: OWNER },
        { delete: remove },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(getStripe).not.toHaveBeenCalled();
    await db
      .update(schema.teamMembers)
      .set({ role: "owner" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: null, stripeSubscriptionId: null })
      .where(eq(schema.teams.id, teamId));
    await withMailboxTeamErasure({ db, getStripe }, { teamId, userId: OWNER }, { delete: remove });
    expect(getStripe).not.toHaveBeenCalled();
    expect(calls).toEqual(["delete"]);
  });
  it("preserves an ambiguous first-Customer request without a linked Customer or SDK calls", async () => {
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: null })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.mailboxCustomerRequests).values({
      teamId,
      createdBy: OWNER,
      status: "creating",
      name: "Team",
      email: "owner@example.invalid",
      livemode: false,
      idempotencyKey: "mailbox-customer:ambiguous",
      createdAt: new Date(0),
    });
    const getStripe = vi.fn(() => stripe);
    await expect(
      withMailboxTeamErasure(
        { db, getStripe, livemode: false },
        { teamId, userId: OWNER },
        { cancelSend, delete: remove },
      ),
    ).rejects.toMatchObject({ code: "pending" });
    expect(getStripe).not.toHaveBeenCalled();
    expect(await team()).toBeDefined();
    expect((await db.select().from(schema.mailboxCustomerRequests))[0]!.status).toBe("creating");
    expect(calls).toEqual([]);
  });
  it("revalidates a customer changed after discovery instead of canceling under the original lock", async () => {
    const intercepted = Object.create(db) as Db;
    intercepted.transaction = ((operation: (tx: Db) => Promise<unknown>) =>
      db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const proxy = new Proxy(tx, {
          get(target, property) {
            if (property === "execute")
              return async (query: Parameters<Db["execute"]>[0]) => {
                const result = await target.execute(query);
                await target
                  .update(schema.teams)
                  .set({ stripeCustomerId: "cus_changed_fixture" })
                  .where(eq(schema.teams.id, teamId));
                return result;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(proxy);
      })) as unknown as Db["transaction"];
    await expect(
      withMailboxTeamErasure(
        { db: intercepted, stripe, livemode: false },
        { teamId, userId: OWNER },
        { cancelSend, delete: remove },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await team())!.stripeCustomerId).toBe(CUSTOMER);
    expect(calls).toEqual([]);
  });
});
