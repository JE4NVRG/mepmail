import { randomUUID } from "node:crypto";
import { holdOnContentVerdict } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PixStripe } from "../src/pix.js";
import { getPurchaseEligibility, preparePurchaseEligibility } from "../src/purchase-eligibility.js";
import { beginSendCheckout, beginSendPixCheckout } from "../src/send-checkout.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

let f: Awaited<ReturnType<typeof checkoutFixture>>;
beforeEach(async () => {
  f = await checkoutFixture();
});
afterEach(async () => f.close());
const team = async () =>
  (await f.db.select().from(schema.teams).where(eq(schema.teams.id, f.input.team.id)))[0]!;
const renameDomain = async (name: string) =>
  f.db.update(schema.domains).set({ name }).where(eq(schema.domains.teamId, f.input.team.id));
const purchase = (method: "card" | "pix") =>
  method === "card"
    ? beginSendCheckout(f.deps, f.input)
    : beginSendPixCheckout(f.deps, {} as PixStripe, f.input);

describe("review before a new payment", () => {
  it("exposes a domain review before a send without creating a hold or a Customer", async () => {
    await renameDomain("legitimate.online");
    expect(await getPurchaseEligibility(f.db, f.input.team.id)).toEqual({
      eligible: false,
      code: "domain_review",
      domains: ["legitimate.online"],
      reviewReason: "new_sender",
    });
    expect((await team()).sendReviewAt).toBeNull();
    expect(await f.db.select().from(schema.teamFlags)).toEqual([]);
    expect(f.posts).toEqual([]);
  });

  it.each(["card", "pix"] as const)(
    "refuses %s without a verified domain before any provider request",
    async (method) => {
      await f.db
        .update(schema.domains)
        .set({ status: "pending", verifiedAt: null })
        .where(eq(schema.domains.teamId, f.input.team.id));
      await expect(purchase(method)).rejects.toMatchObject({ code: "domain_required" });
      expect(f.posts).toEqual([]);
      expect(await f.db.select().from(schema.mailboxCustomerRequests)).toEqual([]);
      expect(await f.db.select().from(schema.sendCheckoutAttempts)).toEqual([]);
    },
  );

  it.each(["card", "pix"] as const)(
    "commits the .online hold before rejecting %s, including retries",
    async (method) => {
      await renameDomain("legitimate.online");
      for (let retry = 0; retry < 2; retry++) {
        await expect(purchase(method)).rejects.toMatchObject({
          code: "domain_review",
          eligibility: { domains: ["legitimate.online"] },
        });
      }
      expect(await team()).toMatchObject({
        plan: "free",
        stripeCustomerId: null,
        sendReviewAt: expect.any(Date),
        sendReviewReason: "new_sender",
        sendReviewNote: expect.stringContaining("is under .online,"),
        sendReviewClearedAt: null,
      });
      expect(await f.db.select().from(schema.teamFlags)).toHaveLength(1);
      expect(await f.db.select().from(schema.mailboxCustomerRequests)).toEqual([]);
      expect(await f.db.select().from(schema.sendCheckoutAttempts)).toEqual([]);
      expect(f.posts).toEqual([]);
    },
  );

  it("prevents a non-admin from putting a team on review", async () => {
    await renameDomain("legitimate.online");
    await f.db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.userId, f.input.userId));
    await expect(
      preparePurchaseEligibility(f.db, { teamId: f.input.team.id, userId: f.input.userId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await team()).sendReviewAt).toBeNull();
  });

  it.each(["card", "pix"] as const)(
    "keeps suspension ahead of %s payment even after an earlier domain release",
    async (method) => {
      await f.db
        .update(schema.teams)
        .set({ sendReviewClearedAt: new Date(), suspendedAt: new Date() })
        .where(eq(schema.teams.id, f.input.team.id));
      await expect(purchase(method)).rejects.toMatchObject({ code: "suspended" });
      expect(f.posts).toEqual([]);
    },
  );

  it.each(["sandbox", "hold"] as const)(
    "does not sell a subscription to a signup in %s or clear its restriction",
    async (level) => {
      await f.db.insert(schema.teamSignupRisk).values({
        teamId: f.input.team.id,
        principalUserId: f.input.userId,
        level,
        reasons: ["private-risk-detail"],
        signals: {
          domain: "example.test",
          disposable: false,
          mx: "present",
          domainAgeDays: null,
          catchAll: "unknown",
          randomLocal: false,
          ipKey: null,
          asn: null,
          signupsIp1h: 1,
          signupsDomain24h: 1,
          signupsAsn1h: 1,
        },
      });
      const code = level === "hold" ? "signup_review" : "signup_sandbox";
      const eligibility = await getPurchaseEligibility(f.db, f.input.team.id);
      expect(eligibility.code).toBe(code);
      expect(JSON.stringify(eligibility)).not.toContain("private-risk-detail");
      await expect(purchase("card")).rejects.toMatchObject({ code });
      await expect(purchase("pix")).rejects.toMatchObject({ code });
      expect((await f.db.select().from(schema.teamSignupRisk))[0]?.clearedAt).toBeNull();
      expect(f.posts).toEqual([]);
    },
  );

  it("keeps a paused reputation guardrail ahead of a new payment", async () => {
    await f.db
      .insert(schema.teamStandings)
      .values({ teamId: f.input.team.id, guardrail: "paused" });
    await expect(purchase("card")).rejects.toMatchObject({ code: "guardrail_paused" });
    expect(f.posts).toEqual([]);
  });

  it("reads current reputation counters even before the safety standing refresh", async () => {
    await f.db.insert(schema.usageCounters).values({
      teamId: f.input.team.id,
      day: new Date().toISOString().slice(0, 10),
      sent: 1000,
      hardBounced: 100,
    });
    const db = f.db;
    const acceptedAt = new Date(Date.now() - 60_000);
    const confirmed = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 1000 }, (_, i) => ({
          teamId: f.input.team.id,
          from: "sender@example.test",
          to: ["recipient@example.test"],
          subject: "Synthetic accepted send",
          createdAt: acceptedAt,
          sentAt: acceptedAt,
          sesMessageId: `fixture-${randomUUID()}-${i}`,
          latestStatus: "sent" as const,
        })),
      )
      .returning({ id: schema.emails.id });
    await db.insert(schema.emailEvents).values(
      confirmed.slice(0, 100).map((row) => ({
        emailId: row.id,
        type: "bounced" as const,
        occurredAt: acceptedAt,
        createdAt: acceptedAt,
        snsMessageId: randomUUID(),
        bounceType: "Permanent",
      })),
    );
    await expect(purchase("pix")).rejects.toMatchObject({ code: "guardrail_paused" });
    expect(f.posts).toEqual([]);
  });

  it("honors an operator's domain release and still holds later phishing content", async () => {
    await renameDomain("legitimate.online");
    await f.db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date() })
      .where(eq(schema.teams.id, f.input.team.id));
    expect(await getPurchaseEligibility(f.db, f.input.team.id)).toMatchObject({ eligible: true });
    await purchase("card");
    expect(f.state.checkouts).toHaveLength(1);
    expect(
      await holdOnContentVerdict(f.db, {
        teamId: f.input.team.id,
        score: 99,
        categories: ["phishing"],
      }),
    ).toBe(true);
    await expect(purchase("card")).rejects.toMatchObject({ code: "send_review" });
    expect((await team()).sendReviewReason).toBe("content");
    expect(f.state.checkouts).toHaveLength(1);
  });

  it("does not extend the existing new-sender age window", async () => {
    await renameDomain("established.online");
    await f.db
      .update(schema.teams)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(schema.teams.id, f.input.team.id));
    expect(await getPurchaseEligibility(f.db, f.input.team.id)).toMatchObject({ eligible: true });
    await purchase("card");
    expect((await team()).sendReviewAt).toBeNull();
  });

  it("does not invent a fifth sender while reviewing a legitimate four-sender team", async () => {
    for (let sender = 1; sender <= 4; sender++)
      await f.db.insert(schema.emails).values({
        teamId: f.input.team.id,
        from: `sender${sender}@sender.example.test`,
        to: ["recipient@example.test"],
        subject: "Legitimate fixture message",
      });
    expect(
      await preparePurchaseEligibility(f.db, { teamId: f.input.team.id, userId: f.input.userId }),
    ).toMatchObject({ eligible: true });
    expect((await team()).sendReviewAt).toBeNull();
  });

  it("rechecks a restriction that appears after Customer creation before creating Checkout", async () => {
    const original = f.db.transaction.bind(f.db);
    const intervening = Object.create(f.db) as Db;
    let held = false;
    intervening.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      const result = await original(...args);
      if (!held && (await team()).stripeCustomerId) {
        held = true;
        await f.db
          .update(schema.teams)
          .set({ sendReviewAt: new Date(), sendReviewReason: "content" })
          .where(eq(schema.teams.id, f.input.team.id));
      }
      return result;
    }) as Db["transaction"];
    await expect(beginSendCheckout({ ...f.deps, db: intervening }, f.input)).rejects.toMatchObject({
      code: "send_review",
    });
    expect(held).toBe(true);
    expect(f.posts.filter((post) => post.kind === "customer")).toHaveLength(1);
    expect(f.posts.filter((post) => post.kind === "session")).toEqual([]);
  });
});
