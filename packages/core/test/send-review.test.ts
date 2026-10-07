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
  disguisedWord,
  findDisguise,
  findImpersonation,
  foldText,
  holdTeamForReview,
  markSendReviewNotified,
  SEND_REVIEW_NEW_TEAM_DAYS,
  screenImpersonation,
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
