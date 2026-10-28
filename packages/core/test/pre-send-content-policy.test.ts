import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { evaluatePreSendContent, screenPreSendContent } from "../src/pre-send-content-policy.js";
import {
  holdTeamForReview,
  isSendReviewHeld,
  screenImpersonation,
  unnotifiedSendReviews,
} from "../src/send-review.js";

const lure = (brand: string) => ({
  from: "Notifications <desk@sender.example>",
  subject: "Notice",
  html: `<p>${brand}: verify your account and update payment</p><a href="https://outside.example/login?token=PRIVATE">Continue</a>`,
});
for (const brand of [
  "Apple",
  "Spotify",
  "PayPal",
  "Nubank",
  "Banco do Brasil",
  "Bank of America",
  "PаyPal",
  "Ａｐｐｌｅ",
  "Spoti\u200bfy",
]) {
  it(`holds mismatched ${brand} body before transport`, () => {
    const verdict = evaluatePreSendContent(lure(brand));
    expect(verdict.action).toBe("hold");
    expect(JSON.stringify(verdict)).not.toContain("PRIVATE");
    expect(JSON.stringify(verdict)).not.toContain("outside.example");
  });
}
it("reads encoded visible HTML, split inline words and plain text destinations", () => {
  expect(
    evaluatePreSendContent({
      ...lure("Ap<span>ple</span>"),
      html: '<p>Ap<span>ple</span>: verify your account</p><a href="https&#58;//outside.example">Continue</a>',
    }).action,
  ).toBe("hold");
  expect(
    evaluatePreSendContent({
      from: "desk@sender.example",
      subject: "PayPal account suspended",
      text: "Confirm your account at https://outside.example/secret",
    }).action,
  ).toBe("hold");
});
it.each([
  "<p>Apple: verify your account at https://outside.example/login</p>",
  "<p>Apple: verify your account at https&#58;&#47;&#47;outside.example/login</p>",
])(
  "screens bare destinations in decoded visible HTML without assuming client auto-linking",
  (html) => {
    expect(
      evaluatePreSendContent({ from: "desk@sender.example", subject: "Notice", html }).action,
    ).toBe("hold");
    expect(
      evaluatePreSendContent({
        from: "desk@sender.example",
        subject: "Notice",
        html: "<p>Apple: verify your account at https://apple.com/account</p>",
      }).action,
    ).toBe("allow");
  },
);
it("allows a benign Power BI course and a brand mention without an account lure", () => {
  expect(
    evaluatePreSendContent({
      ...lure("Power BI"),
      subject: "Curso de Power BI",
      html: '<p>Curso de Power BI com integracao Microsoft</p><a href="https://school.example">Conheca o curso</a>',
    }).action,
  ).toBe("allow");
  expect(
    evaluatePreSendContent({
      ...lure("Apple"),
      html: '<p>Apple product news</p><a href="https://news.example">Read</a>',
    }).action,
  ).toBe("allow");
});
it("allows aligned real account mail, including our password reset", () => {
  expect(
    evaluatePreSendContent({
      from: "MepMail <account@mepmail.app>",
      subject: "MepMail password reset",
      html: '<p>Reset your password</p><a href="https://mepmail.app/reset?token=PRIVATE">Reset</a>',
    }).action,
  ).toBe("allow");
  expect(
    evaluatePreSendContent({ ...lure("Apple"), from: "Apple <account@apple.com>" }).action,
  ).toBe("allow");
  expect(
    evaluatePreSendContent({
      ...lure("Apple"),
      html: '<p>Apple: verify your account</p><a href="https://apple.com/account">Continue</a>',
    }).action,
  ).toBe("allow");
  expect(
    evaluatePreSendContent({
      ...lure("Apple"),
      html: '<p>Apple: verify your account</p><a href="https://apple.com.attacker.example/account">Continue</a>',
    }).action,
  ).toBe("hold");
});
it("fails closed rather than truncating an uninspectable body", () => {
  expect(() => evaluatePreSendContent({ ...lure("Apple"), html: "x".repeat(2_000_001) })).toThrow(
    "pre_send_content_unavailable",
  );
});

let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => {
  await fixture?.close();
});
it("rearms a cleared watermark atomically, keeps the first active reason and alerts again", async () => {
  const { db } = fixture;
  const teamId = await createTeam(db, "watermark-rearm");
  const old = new Date("2026-01-01T00:00:00Z");
  const cleared = new Date("2026-01-02T00:00:00Z");
  const now = new Date("2026-01-03T00:00:00Z");
  await db
    .update(schema.teams)
    .set({ sendReviewAt: old, sendReviewClearedAt: cleared, sendReviewNotifiedAt: old })
    .where(eq(schema.teams.id, teamId));
  expect(isSendReviewHeld({ sendReviewAt: old, sendReviewClearedAt: cleared })).toBe(false);
  expect((await screenPreSendContent(db, { ...lure("Spotify"), teamId, now })).action).toBe("hold");
  expect(
    await holdTeamForReview(db, { teamId, now, reason: "impersonation", note: "duplicate" }),
  ).toBe(false);
  const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(row?.sendReviewAt).toEqual(now);
  expect(row?.sendReviewReason).toBe("content");
  expect(row?.sendReviewNotifiedAt).toBeNull();
  expect(isSendReviewHeld(row!)).toBe(true);
  expect((await unnotifiedSendReviews(db)).some((r) => r.id === teamId)).toBe(true);
});
it("does not let a stale finding overwrite a newer release, but still blocks the payload", async () => {
  const { db } = fixture;
  const teamId = await createTeam(db, "release-race");
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date("2026-02-02T00:00:00Z") })
    .where(eq(schema.teams.id, teamId));
  expect(
    (
      await screenPreSendContent(db, {
        ...lure("Apple"),
        teamId,
        now: new Date("2026-02-01T00:00:00Z"),
      })
    ).action,
  ).toBe("hold");
  const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(row?.sendReviewAt).toBeNull();
});
it("screens old, reviewed and system teams again for new forged identities", async () => {
  const { db } = fixture;
  for (const plan of ["free", "system"] as const) {
    const teamId = await createTeam(db, `old-reviewed-${plan}`);
    await db
      .update(schema.teams)
      .set({ plan, createdAt: new Date("2025-01-01"), sendReviewClearedAt: new Date("2026-01-01") })
      .where(eq(schema.teams.id, teamId));
    expect(
      await screenImpersonation(db, {
        teamId,
        from: "PayPal <fraud@sender.example>",
        subject: "Notice",
      }),
    ).toBe(true);
  }
});
