import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptEmail } from "../src/accept-email.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import type { QuotaTeamRow } from "../src/plans.js";
import {
  abuseProneTld,
  disguisedWord,
  findDisguise,
  findImpersonation,
  foldText,
  CONTENT_HOLD_SCORE,
  holdOnContentVerdict,
  holdReputationRuns,
  holdTeamForReview,
  markSendReviewNotified,
  PROBATION_DAILY_RECIPIENTS,
  PROBATION_DAYS,
  SEND_REVIEW_NEW_TEAM_DAYS,
  SENDER_ROTATION_LIMIT,
  screenImpersonation,
  screenNewSender,
  unnotifiedSendReviews,
} from "../src/send-review.js";
import { syncTeamFlags } from "../src/team-flags.js";
import { fetchTeamStanding } from "../src/team-standing.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

// The sender of the phishing run that motivated the screen: Cyrillic В а с о
// around a Latin n, then С Т Т spelled wholly in Cyrillic.
const DISGUISED = "Ваnсо СТТ";

describe("disguisedWord", () => {
  it("finds a word that mixes alphabets", () => {
    expect(disguisedWord(DISGUISED)).toBe("Ваnсо");
    expect(disguisedWord("PаyPal")).toBe("PаyPal");
  });

  it("finds a look-alike word beside Latin words", () => {
    expect(disguisedWord("Banco СТТ")).toBe("СТТ");
  });

  it("leaves genuine text in any one alphabet alone", () => {
    expect(disguisedWord("Banco CTT")).toBeNull();
    expect(disguisedWord("Ação necessária: confirme já")).toBeNull();
    expect(disguisedWord("Москва")).toBeNull();
    expect(disguisedWord("ООО Ромашка LLC")).toBeNull();
    expect(disguisedWord("Αθήνα Travel")).toBeNull();
    expect(disguisedWord("東京 Tokyo ストア")).toBeNull();
    expect(disguisedWord("Ünïcödé Café Ñandú")).toBeNull();
  });
});

describe("findDisguise", () => {
  it("refuses a disguised sender name or subject", () => {
    expect(findDisguise({ from: `"${DISGUISED}" <news@x.dev>`, subject: "Olá" })).toEqual({
      field: "from",
      sample: "Ваnсо",
    });
    expect(findDisguise({ from: "news@x.dev", subject: "Seu рedido" })).toEqual({
      field: "subject",
      sample: "рedido",
    });
  });

  it("refuses hidden characters in the name and overrides in the subject", () => {
    expect(findDisguise({ from: "Pay​Pal <a@x.dev>", subject: "Hi" })?.field).toBe("from");
    expect(findDisguise({ from: "a@x.dev", subject: "fdp.‮exe" })?.field).toBe("subject");
  });

  it("passes ordinary mail, emoji sequences included", () => {
    expect(findDisguise({ from: "Acme <a@x.dev>", subject: "Your receipt 👨‍👩‍👧" })).toBeNull();
    expect(findDisguise({ from: "a@x.dev", subject: "Ação necessária" })).toBeNull();
  });
});

describe("findImpersonation", () => {
  it("folds accents and look-alikes before matching", () => {
    expect(foldText(DISGUISED)).toBe("banco ctt");
    expect(foldText("Ação Necessária!")).toBe("acao necessaria");
  });

  it("reads brand names in the sender name and lures in either field", () => {
    expect(findImpersonation({ from: "Banco CTT <news@x.dev>", subject: "Olá" })).toEqual({
      field: "from",
      term: "banco",
    });
    expect(
      findImpersonation({
        from: "news@x.dev",
        subject: "Ação necessária: confirme os seus contactos",
      }),
    ).toEqual({ field: "subject", term: "confirme os seus contactos" });
    expect(
      findImpersonation({ from: "Segurança da Conta <a@x.dev>", subject: "Aviso" }),
    ).toMatchObject({ field: "from" });
  });

  it("reads the 2026-10-07 runs: an insurer refund in French and an ISP security notice", () => {
    expect(
      findImpersonation({
        from: "Assurances <sales@millionsmiledental.com.au>",
        subject: "Remboursement de prestations I2PORKMM",
      }),
    ).toEqual({ field: "from", term: "assurances" });
    expect(
      findImpersonation({
        from: "Notifications <support@millionsmiledental.com.au>",
        subject: "Message important pour vous – Otmane",
      }),
    ).toEqual({ field: "subject", term: "message important pour vous" });
    expect(
      findImpersonation({
        from: "Tech Team <info@fbx-centre.site>",
        subject: "New App Linked To Your Account",
      }),
    ).toEqual({ field: "subject", term: "new app linked" });
    expect(
      findImpersonation({ from: "Account Security <info@fbx-centre.site>", subject: "Hi" }),
    ).toEqual({ field: "from", term: "security" });
  });

  it("matches whole words only, and brand names only in the sender", () => {
    expect(findImpersonation({ from: "Bankside Studio <a@x.dev>", subject: "Hi" })).toBeNull();
    expect(
      findImpersonation({ from: "Acme <a@x.dev>", subject: "New Google integration" }),
    ).toBeNull();
    expect(findImpersonation({ from: "Acme <a@x.dev>", subject: "Weekly digest" })).toBeNull();
  });
});

describe("holds", () => {
  it("holds a young team once, opens the review flag and parks its standing", async () => {
    const teamId = await createTeam(db, "young-imitator");
    expect(
      await screenImpersonation(db, {
        teamId,
        from: "Banco CTT <news@young.dev>",
        subject: "Olá",
      }),
    ).toBe(true);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.sendReviewReason).toBe("impersonation");
    expect(team?.sendReviewNote).toContain("banco");
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.reason).toBe("impersonation");
    const flags = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(flags).toMatchObject([{ reason: "review", status: "open" }]);
    // A second match keeps the first hold.
    expect(await holdTeamForReview(db, { teamId, reason: "payment_risk", note: "again" })).toBe(
      false,
    );
    // The safety cron neither relabels nor clears a review flag.
    await syncTeamFlags(db, [], new Date(), []);
    const after = await db
      .select()
      .from(schema.teamFlags)
      .where(eq(schema.teamFlags.teamId, teamId));
    expect(after).toMatchObject([{ reason: "review", status: "open" }]);
  });

  it("leaves established and released teams alone", async () => {
    const old = await createTeam(db, "old-bank");
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(Date.now() - (SEND_REVIEW_NEW_TEAM_DAYS + 1) * 86_400_000) })
      .where(eq(schema.teams.id, old));
    expect(
      await screenImpersonation(db, { teamId: old, from: "Banco <a@old.dev>", subject: "Olá" }),
    ).toBe(false);
    const released = await createTeam(db, "released-bank");
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date(), sendReviewClearedBy: "op" })
      .where(eq(schema.teams.id, released));
    expect(
      await screenImpersonation(db, {
        teamId: released,
        from: "Banco <a@released.dev>",
        subject: "Olá",
      }),
    ).toBe(false);
    for (const id of [old, released]) {
      const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, id));
      expect(row?.sendReviewAt).toBeNull();
    }
  });

  it("lists a hold for the operator once", async () => {
    const teamId = await createTeam(db, "notice-once");
    await holdTeamForReview(db, { teamId, reason: "payment_risk", note: "Radar blocked ch_1" });
    expect((await unnotifiedSendReviews(db)).map((r) => r.id)).toContain(teamId);
    expect(await markSendReviewNotified(db, teamId, new Date())).toBe(true);
    expect(await markSendReviewNotified(db, teamId, new Date())).toBe(false);
    expect((await unnotifiedSendReviews(db)).map((r) => r.id)).not.toContain(teamId);
  });
});

describe("acceptEmail on the cloud", () => {
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const deps = () => ({ db, keyring, isCloud: true, enqueueEmailSend: async () => {} });

  async function teamWithDomain(slug: string) {
    const teamId = await createTeam(db, slug);
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: `${slug}.dev`, region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    if (!domain) throw new Error("domain insert failed");
    return { teamId, domainId: domain.id };
  }

  const billing: QuotaTeamRow = {
    plan: "free",
    planQuota: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    overageEnabled: false,
  };

  it("refuses a disguised sender before anything is stored", async () => {
    const { teamId, domainId } = await teamWithDomain("disguised");
    const result = await acceptEmail(
      deps(),
      { teamId, billing, apiKeyId: null },
      {
        from: `"${DISGUISED}" <news@disguised.dev>`,
        to: ["a@b.dev"],
        subject: "Ação necessária",
        text: "x",
        domainId,
      },
    );
    expect(result).toMatchObject({ ok: false, reason: "disguised_sender", field: "from" });
    const rows = await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));
    expect(rows).toHaveLength(0);
  });

  it("accepts an imitating young team's mail and holds the team", async () => {
    const { teamId, domainId } = await teamWithDomain("imitator");
    const result = await acceptEmail(
      deps(),
      { teamId, billing, apiKeyId: null },
      {
        from: "Banco CTT <news@imitator.dev>",
        to: ["a@b.dev"],
        subject: "Ação necessária: confirme os seus contactos",
        text: "x",
        domainId,
      },
    );
    expect(result.ok).toBe(true);
    expect((await fetchTeamStanding(db, teamId))?.sendReview).not.toBeNull();
  });
});

describe("new sender patterns", () => {
  async function youngTeam(slug: string, ageDays = 1) {
    const teamId = await createTeam(db, slug);
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(Date.now() - ageDays * 86_400_000) })
      .where(eq(schema.teams.id, teamId));
    return teamId;
  }
  const sent = (teamId: string, from: string, to: string[] = ["a@b.dev"]) =>
    db.insert(schema.emails).values({ teamId, from, to, subject: "Hello" });
  const teamRow = async (teamId: string) =>
    (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0];

  it("names abuse-prone TLDs only", () => {
    expect(abuseProneTld("info@fbx-centre.site")).toBe("site");
    expect(abuseProneTld("rich@coursaee.fit")).toBe("fit");
    expect(abuseProneTld("a@mail.mepmail.dev")).toBeNull();
    expect(abuseProneTld("a@millionsmiledental.com.au")).toBeNull();
  });

  it("holds a young team sending from an abuse-prone TLD before its first message", async () => {
    const teamId = await youngTeam("tld-site");
    expect(
      await screenNewSender(db, { teamId, from: "Tech <info@fbx-centre.site>", recipients: 1 }),
    ).toBe(true);
    const team = await teamRow(teamId);
    expect(team?.sendReviewReason).toBe("new_sender");
    expect(team?.sendReviewNote).toContain(".site");
  });

  it("holds a young team rotating sender addresses, not one using a few", async () => {
    const teamId = await youngTeam("rotator");
    for (let i = 1; i < SENDER_ROTATION_LIMIT; i++) {
      await sent(teamId, `Desk ${i} <s${i}@rotator.dev>`);
    }
    expect(
      await screenNewSender(db, { teamId, from: "Desk <s1@rotator.dev>", recipients: 1 }),
    ).toBe(false);
    const last = `Desk <s${SENDER_ROTATION_LIMIT}@rotator.dev>`;
    expect(await screenNewSender(db, { teamId, from: last, recipients: 1 })).toBe(false);
    await sent(teamId, last);
    expect(
      await screenNewSender(db, { teamId, from: "Accueil <contrat@rotator.dev>", recipients: 1 }),
    ).toBe(true);
    expect((await teamRow(teamId))?.sendReviewNote).toContain("sender addresses in 24 hours");
  });

  it("holds a team inside its probation days past the daily recipients", async () => {
    const teamId = await youngTeam("probation");
    const batch = Array.from({ length: PROBATION_DAILY_RECIPIENTS - 10 }, (_, i) => `r${i}@b.dev`);
    await sent(teamId, "news@probation.dev", batch);
    expect(await screenNewSender(db, { teamId, from: "news@probation.dev", recipients: 10 })).toBe(
      false,
    );
    expect(await screenNewSender(db, { teamId, from: "news@probation.dev", recipients: 11 })).toBe(
      true,
    );
    expect((await teamRow(teamId))?.sendReviewNote).toContain("probation day");
    // Past the probation days the volume is the plan's business.
    const older = await youngTeam("past-probation", PROBATION_DAYS + 1);
    await sent(older, "news@past.dev", batch);
    expect(
      await screenNewSender(db, { teamId: older, from: "news@past.dev", recipients: 50 }),
    ).toBe(false);
  });

  it("leaves established, released and system teams alone", async () => {
    const old = await youngTeam("old-site", SEND_REVIEW_NEW_TEAM_DAYS + 1);
    expect(await screenNewSender(db, { teamId: old, from: "a@old.site", recipients: 1 })).toBe(
      false,
    );
    const released = await youngTeam("released-site");
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date(), sendReviewClearedBy: "op" })
      .where(eq(schema.teams.id, released));
    expect(
      await screenNewSender(db, { teamId: released, from: "a@released.site", recipients: 500 }),
    ).toBe(false);
    const system = await youngTeam("system-site");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    expect(
      await screenNewSender(db, { teamId: system, from: "a@sys.site", recipients: 500 }),
    ).toBe(false);
  });

  it("holds every send of a team whose guardrail paused, unless released this week", async () => {
    const bad = await youngTeam("bounce-run", 60);
    const releasedLately = await youngTeam("released-lately", 60);
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date(Date.now() - 86_400_000), sendReviewClearedBy: "op" })
      .where(eq(schema.teams.id, releasedLately));
    const fine = await youngTeam("fine", 60);
    const paused = (teamId: string) => ({
      teamId,
      guardrail: "paused",
      guardrailMetric: "hard_bounce" as const,
      complaintRate7d: 0,
      hardBounceRate7d: 0.08,
    });
    const held = await holdReputationRuns(db, [
      paused(bad),
      paused(releasedLately),
      { ...paused(fine), guardrail: "ok" },
    ]);
    expect(held).toEqual([bad]);
    expect((await teamRow(bad))?.sendReviewReason).toBe("reputation");
    expect((await teamRow(bad))?.sendReviewNote).toContain("8.00%");
    expect((await fetchTeamStanding(db, bad))?.sendReview?.reason).toBe("reputation");
    expect((await teamRow(releasedLately))?.sendReviewAt).toBeNull();
    // A held team is not held again.
    expect(await holdReputationRuns(db, [paused(bad)])).toEqual([]);
  });
});

describe("acceptEmail screens a new sender", () => {
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  it("accepts mail from an abuse-prone domain and holds the young team", async () => {
    const teamId = await createTeam(db, "accept-site");
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "accept-centre.site", region: "us-east-1", status: "verified" })
      .returning({ id: schema.domains.id });
    const billing: QuotaTeamRow = {
      plan: "free",
      planQuota: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      overageEnabled: false,
    };
    const result = await acceptEmail(
      { db, keyring, isCloud: true, enqueueEmailSend: async () => {} },
      { teamId, billing, apiKeyId: null },
      {
        from: "Team <hi@accept-centre.site>",
        to: ["a@b.dev"],
        subject: "Welcome",
        text: "x",
        domainId: domain?.id ?? null,
      },
    );
    expect(result.ok).toBe(true);
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.reason).toBe("new_sender");
  });
});

describe("content verdict hold", () => {
  async function aged(slug: string, ageDays: number) {
    const teamId = await createTeam(db, slug);
    await db
      .update(schema.teams)
      .set({ createdAt: new Date(Date.now() - ageDays * 86_400_000) })
      .where(eq(schema.teams.id, teamId));
    return teamId;
  }

  it("holds a young team on a near-certain verdict, even one an operator released", async () => {
    const teamId = await aged("content-young", 2);
    expect(
      await holdOnContentVerdict(db, { teamId, score: CONTENT_HOLD_SCORE - 1, categories: ["scam"] }),
    ).toBe(false);
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date(), sendReviewClearedBy: "op" })
      .where(eq(schema.teams.id, teamId));
    expect(
      await holdOnContentVerdict(db, { teamId, score: 100, categories: ["phishing_credentials"] }),
    ).toBe(true);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team).toMatchObject({ sendReviewReason: "content" });
    expect(team?.sendReviewNote).toBe("Content monitor verdict 100/100 (phishing_credentials)");
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.reason).toBe("content");
  });

  it("leaves established, suspended and system teams to the monitor's own alert", async () => {
    const old = await aged("content-old", SEND_REVIEW_NEW_TEAM_DAYS + 1);
    expect(await holdOnContentVerdict(db, { teamId: old, score: 100, categories: [] })).toBe(false);
    const suspended = await aged("content-suspended", 1);
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date(), suspensionReason: "phishing" })
      .where(eq(schema.teams.id, suspended));
    expect(await holdOnContentVerdict(db, { teamId: suspended, score: 100, categories: [] })).toBe(
      false,
    );
    const system = await aged("content-system", 1);
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, system));
    expect(await holdOnContentVerdict(db, { teamId: system, score: 100, categories: [] })).toBe(
      false,
    );
  });
});
