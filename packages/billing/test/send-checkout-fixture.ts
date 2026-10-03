import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { type SendCheckoutInput } from "../src/send-checkout.js";
import { fakeStripe } from "./helpers.js";

export async function checkoutFixture() {
  const { db, close } = await createTestDb();
  // Real pinned Mail0007 DDL: the Customer claim is shared; no duplicate test-only table contract.
  const ddl = readFileSync(
    new URL("../../db/mailbox-drizzle/0007_mailbox_customer_request.sql", import.meta.url),
    "utf8",
  );
  for (const statement of ddl.split("--> statement-breakpoint").filter((s) => s.trim()))
    await db.execute(sql.raw(statement));
  const teamId = await createTeam(db);
  const userId = randomUUID();
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Owner", email: `${userId}@example.test` });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  const provider = checkoutProvider();
  const input: SendCheckoutInput = {
    team: { id: teamId, name: "acme", stripeCustomerId: null },
    userId,
    rung: "pro_100k",
    email: `${userId}@example.test`,
    successUrl: "https://app/ok",
    cancelUrl: "https://app/back",
    automaticTax: false,
  };
  return {
    db,
    close,
    ...provider,
    input,
    deps: { db: db as Db, stripe: provider.stripe, livemode: false },
  };
}

export function checkoutProvider(prefix = "") {
  const { stripe, state } = fakeStripe();
  const customers = new Map<string, Stripe.Customer>();
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const posts: Array<{ kind: string; key: string; parameters: unknown }> = [];
  let customerLost = false;
  let sessionLost = false;
  let hideSessions = false;
  stripe.customers.create = async (parameters, options) => {
    const key = options?.idempotencyKey ?? "missing";
    posts.push({ kind: "customer", key, parameters: structuredClone(parameters) });
    let customer = customers.get(key);
    if (!customer) {
      customer = {
        id: `cus_${prefix}${customers.size + 1}`,
        livemode: false,
        name: parameters.name,
        email: parameters.email,
        metadata: parameters.metadata,
      } as Stripe.Customer;
      customers.set(key, customer);
      state.customers.push(parameters);
    }
    if (customerLost) throw new Error("provider succeeded but reply was lost");
    return customer;
  };
  stripe.customers.retrieve = async (id) => {
    const customer = [...customers.values()].find((c) => c.id === id);
    if (!customer) throw new Error("missing Customer");
    return customer;
  };
  stripe.checkout.sessions.create = async (parameters, options) => {
    const key = options?.idempotencyKey ?? "missing";
    posts.push({ kind: "session", key, parameters: structuredClone(parameters) });
    let session = sessions.get(key);
    if (!session) {
      const id = `cs_${prefix}${sessions.size + 1}`;
      session = {
        id,
        mode: "subscription",
        livemode: false,
        customer: parameters.customer,
        client_reference_id: parameters.client_reference_id,
        metadata: parameters.metadata,
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      } as Stripe.Checkout.Session;
      sessions.set(key, session);
      state.checkouts.push(parameters);
    }
    if (sessionLost) throw new Error("provider succeeded but reply was lost");
    return session;
  };
  stripe.checkout.sessions.list = async (parameters) =>
    ({
      data: hideSessions
        ? []
        : [...sessions.values()].filter((s) => s.customer === parameters.customer),
      has_more: false,
    }) as Stripe.ApiList<Stripe.Checkout.Session>;
  stripe.checkout.sessions.retrieve = async (id) => {
    const session = [...sessions.values()].find((s) => s.id === id);
    if (!session) throw new Error("missing Session");
    return session;
  };
  return {
    stripe,
    state,
    customers,
    sessions,
    posts,
    loseCustomer: (v = true) => {
      customerLost = v;
    },
    loseSession: (v = true) => {
      sessionLost = v;
    },
    hideSessions: (v = true) => {
      hideSessions = v;
    },
  };
}
