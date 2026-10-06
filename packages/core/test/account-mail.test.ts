import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { en } from "../src/account-mail/en.js";
import { ptBR } from "../src/account-mail/pt-BR.js";
import {
  ACCOUNT_MAIL_KINDS,
  type AccountMailEntry,
  accountMailPhrase,
  buildAccountMail,
  formatMailDate,
  MAIL_LOCALES,
  planCapPhrase,
  planMove,
} from "../src/account-mail.js";
import {
  accountMailCard,
  EMAIL_WHITE_TILE_URL,
  EMAIL_WORDMARK_BONE_URL,
  EMAIL_WORDMARK_INK_URL,
} from "../src/html.js";
import { mailPreferenceOf } from "../src/mail-preferences.js";
import { listTeamOwners } from "../src/notifications.js";
import type { SystemMailKind } from "../src/system-mail.js";

const VALUES: Record<string, string> = Object.fromEntries(
  [...Object.values(en), ...Object.values(ptBR)]
    .flatMap((e: AccountMailEntry) => [
      e.subject,
      ...e.body,
      e.button,
      ...(e.muted ?? []),
      ...Object.values(e.extra ?? {}),
    ])
    .flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string))
    .map((key) => [key, `[${key}]`]),
);

describe("account mail catalogs", () => {
  it("render every kind in every language with no placeholder left", () => {
    for (const locale of MAIL_LOCALES) {
      for (const kind of ACCOUNT_MAIL_KINDS) {
        const mail = buildAccountMail({
          kind,
          locale,
          url: "https://app.example/x",
          values: VALUES,
        });
        expect(mail.subject, `${locale} ${kind}`).not.toMatch(/\{\w+\}/);
        expect(mail.text, `${locale} ${kind}`).not.toMatch(/\{\w+\}/);
        expect(mail.html, `${locale} ${kind}`).toContain("https://app.example/x");
      }
    }
  });

  it("carries the same slots in pt-BR as in en, entry by entry", () => {
    const slots = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
    for (const kind of ACCOUNT_MAIL_KINDS) {
      const a: AccountMailEntry = en[kind];
      const b: AccountMailEntry = ptBR[kind];
      expect(slots(b.subject), `${kind} subject`).toEqual(slots(a.subject));
      expect(slots(b.body.join(" ")), `${kind} body`).toEqual(slots(a.body.join(" ")));
      expect(Object.keys(b.extra ?? {}).sort(), `${kind} extra`).toEqual(
        Object.keys(a.extra ?? {}).sort(),
      );
      for (const key of Object.keys(a.extra ?? {})) {
        expect(slots(b.extra?.[key] ?? ""), `${kind} extra ${key}`).toEqual(
          slots(a.extra?.[key] ?? ""),
        );
      }
    }
  });

  it("escapes what the values carry", () => {
    const mail = buildAccountMail({
      kind: "member.joined",
      locale: "en",
      url: "https://app.example/settings",
      values: { ...VALUES, team: "<b>Acme</b>" },
    });
    expect(mail.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Acme</b>");
    expect(mail.text).toContain("<b>Acme</b>");
  });

  it("fills a phrase from an entry's extras", () => {
    expect(
      accountMailPhrase({
        locale: "pt-BR",
        kind: "billing.payment_failed",
        key: "retryOn",
        values: { date: "1 de outubro" },
      }),
    ).toBe("A Stripe tenta de novo em 1 de outubro.");
  });
});

describe("accountMailCard", () => {
  it("names the button in the text version when there is no link fallback", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://app.example/x",
      muted: ["Bye"],
    });
    expect(card.text).toBe("Hello\n\nOpen: https://app.example/x\n\nBye\n");
    expect(card.html).not.toContain("word-break:break-all");
  });

  it("prints the bare link when a fallback line is given", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://app.example/x",
      linkFallback: "Or paste this:",
      muted: [],
    });
    expect(card.text).toBe("Hello\n\nhttps://app.example/x\n\n\n");
    expect(card.html).toContain("Or paste this:<br>");
  });

  it("leads with the heading and drops the button when there is no url", () => {
    const card = accountMailCard({ heading: "It works.", paragraphs: ["Hello"], muted: [] });
    expect(card.html).toContain(">It works.</p>");
    expect(card.html).not.toContain('class="ms-btn"');
    expect(card.text.startsWith("It works.\n\nHello")).toBe(true);
  });

  it("carries both wordmarks and the theme sheet", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://x.y",
      muted: [],
    });
    expect(card.html).toContain("wordmark-ink.png");
    expect(card.html).toContain("wordmark-bone.png");
    expect(card.html).toContain("@media (prefers-color-scheme:dark)");
    expect(card.html).toContain("u + .body .ms-gmail");
  });

  it("keeps the original language, home and asset URLs when overrides are omitted", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://x.y",
      muted: [],
    });
    expect(card.html).toContain('<html lang="en">');
    expect(card.html).toContain('<a href="https://je4ndev.com"');
    expect(card.html).toContain(`src="${EMAIL_WORDMARK_INK_URL}"`);
    expect(card.html).toContain(`src="${EMAIL_WORDMARK_BONE_URL}"`);
    expect(card.html).toContain(`background:#ffffff url(${EMAIL_WHITE_TILE_URL});`);
    expect(card.text).toBe("Hello\n\nOpen: https://x.y\n\n\n");
  });

  it("escapes explicit language and home attributes and quotes the Gmail asset URL", () => {
    const card = accountMailCard({
      paragraphs: ["Hello"],
      button: "Open",
      url: "https://x.y",
      muted: [],
      locale: 'pt-BR" data-injected="yes',
      homeUrl: "https://mepmail.dev/?a=1&b=2",
      assetBaseUrl: "https://assets.example/path');color:red;/*",
    });
    expect(card.html).toContain('<html lang="pt-BR&quot; data-injected=&quot;yes">');
    expect(card.html).not.toContain('lang="pt-BR" data-injected="yes"');
    expect(card.html).toContain('href="https://mepmail.dev/?a=1&amp;b=2"');
    expect(card.html).toContain("background:#ffffff url(&quot;https://assets.example/");
    expect(card.html).toContain("/email/white.png&quot;);");
    expect(card.text).not.toContain("data-injected");
  });

  it("rejects executable or credential-bearing branding URLs", () => {
    const input = { paragraphs: ["Hello"], muted: [] };
    expect(() => accountMailCard({ ...input, homeUrl: "javascript:alert(1)" })).toThrow(
      "HTTPS URL",
    );
    expect(() =>
      accountMailCard({ ...input, assetBaseUrl: "https://user:password@example.com" }),
    ).toThrow("HTTPS URL");
    expect(() => accountMailCard({ ...input, assetBaseUrl: "https://example.com/?x=1" })).toThrow(
      "query or fragment",
    );
  });
});

describe("listTeamOwners", () => {
  // The PGlite boot belongs in the hook: it has the long timeout, the test does not.
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(() => close());

  it("reads each owner's language off their contact in the account-mail team, English otherwise", async () => {
    const teamId = await createTeam(db, "acme");
    const home = await createTeam(db, "home");
    await db.insert(schema.domains).values({
      teamId: home,
      name: "mail.example.com",
      region: "us-east-1",
      status: "verified",
    });
    await db.insert(schema.user).values([
      { id: "u1", name: "Ana", email: "Ana@example.com" },
      { id: "u2", name: "Bob", email: "bob@example.com" },
      { id: "u3", name: "Cid", email: "cid@example.com" },
    ]);
    await db.insert(schema.teamMembers).values([
      { teamId, userId: "u1", role: "owner" },
      { teamId, userId: "u2", role: "owner" },
      { teamId, userId: "u3", role: "member" },
    ]);
    await db.insert(schema.contacts).values([
      { teamId: home, email: "ana@example.com", properties: { locale: "pt-BR" } },
      { teamId: home, email: "bob@example.com", properties: { locale: "xx" } },
    ]);
    const owners = await listTeamOwners(db, teamId, "MepMail <account@mail.example.com>");
    expect(owners.map((o) => [o.email, o.locale]).sort()).toEqual([
      ["Ana@example.com", "pt-BR"],
      ["bob@example.com", "en"],
    ]);
    // No sender, or a sender no team holds: nothing to read, English.
    expect((await listTeamOwners(db, teamId)).map((o) => o.locale)).toEqual(["en", "en"]);
    expect((await listTeamOwners(db, teamId, "x@nobody.example.com")).map((o) => o.locale)).toEqual(
      ["en", "en"],
    );
  });

  it("leaves out an owner who turned a notice off, never for mail that is always sent", async () => {
    const teamId = await createTeam(db, "quiet");
    await db.insert(schema.user).values({
      id: "q1",
      name: "Q",
      email: "q@example.com",
      mailOptOuts: ["broadcast.sent", "quota", "domain.lost"],
    });
    await db.insert(schema.teamMembers).values({ teamId, userId: "q1", role: "owner" });
    const emails = async (kind?: SystemMailKind) =>
      (await listTeamOwners(db, teamId, undefined, kind)).map((o) => o.email);
    expect(await emails()).toEqual(["q@example.com"]);
    expect(await emails("broadcast.sent")).toEqual([]);
    expect(await emails("quota.paused")).toEqual([]);
    expect(await emails("domain.lost.identity")).toEqual([]);
    expect(await emails("broadcast.held")).toEqual(["q@example.com"]);
    expect(await emails("api_key.created")).toEqual(["q@example.com"]);
  });
});

describe("billing phrases", () => {
  it("say a plan's cap as a clause and a date on its UTC day, each in the reader's language", () => {
    expect(planCapPhrase("en", "starter", null)).toBe("up to 1,500 emails a day");
    expect(planCapPhrase("pt-BR", "starter", null)).toBe("até 1.500 e-mails por dia");
    expect(planCapPhrase("en", "pro", 110_000)).toBe("up to 110,000 emails a month");
    expect(planCapPhrase("pt-BR", "pro", 110_000)).toBe("até 110.000 e-mails por mês");
    expect(planCapPhrase("en", "scale", 2_750_000)).toBe("up to 2,750,000 emails a month");
    expect(planCapPhrase("en", "system", null)).toBe("with no sending cap");
    expect(planCapPhrase("pt-BR", "system", null)).toBe("sem limite de envio");
    const lateUtc = new Date("2026-09-30T23:30:00Z");
    expect(formatMailDate("en", lateUtc)).toBe("September 30, 2026");
    expect(formatMailDate("pt-BR", lateUtc)).toBe("30 de setembro de 2026");
  });
});

describe("planMove", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  const row = (
    plan: "free" | "pro" | "scale" | "system",
    periodEnd: string | null,
    cancelAt: string | null = null,
    planQuota: number | null = null,
  ) => ({
    plan,
    planQuota,
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
    cancelAt: cancelAt ? new Date(cancelAt) : null,
  });

  it("keys an activation and a change by the period the new plan starts, and a downgrade by the period that ended", () => {
    const up = planMove(row("free", null), row("pro", "2026-10-08T00:00:00Z", null, 110_000), now);
    expect(up?.kind).toBe("billing.plan_activated");
    expect(up?.periodKey).toBe("pro_100k:2026-10-08T00:00:00.000Z");
    expect(up?.values("en", "Acme")).toEqual({
      team: "Acme",
      plan: "Pro 110K",
      cap: "up to 110,000 emails a month",
    });
    const moved = planMove(
      row("pro", "2026-10-08T00:00:00Z", null, 110_000),
      row("scale", "2026-10-08T00:00:00Z", null, 550_000),
      now,
    );
    expect(moved?.kind).toBe("billing.plan_changed");
    expect(moved?.periodKey).toBe("pro_100k>scale_500k:2026-10-08T00:00:00.000Z");
    expect(moved?.values("pt-BR", "Acme")).toMatchObject({
      old: "Pro 110K",
      new: "Scale 550K",
      cap: "até 550.000 e-mails por mês",
    });
    // A step between rungs of one plan is a change like any other.
    const stepped = planMove(
      row("pro", "2026-10-08T00:00:00Z", null, 110_000),
      row("pro", "2026-10-08T00:00:00Z", null, 220_000),
      now,
    );
    expect(stepped?.kind).toBe("billing.plan_changed");
    expect(stepped?.periodKey).toBe("pro_100k>pro_200k:2026-10-08T00:00:00.000Z");
    expect(stepped?.values("en", "Acme")).toEqual({
      team: "Acme",
      old: "Pro 110K",
      new: "Pro 220K",
      cap: "up to 220,000 emails a month",
    });
    const down = planMove(row("pro", "2026-09-30T00:00:00Z"), row("free", null), now);
    expect(down?.kind).toBe("billing.downgraded");
    expect(down?.periodKey).toBe("2026-09-30T00:00:00.000Z");
    expect(planMove(row("pro", null), row("pro", null), now)).toBeNull();
  });

  it("says nothing about a move into or out of the system plan", () => {
    expect(
      planMove(row("scale", "2026-10-08T00:00:00Z", null, 550_000), row("system", null), now),
    ).toBeNull();
    expect(planMove(row("system", null), row("free", null), now)).toBeNull();
    expect(planMove(row("system", null), row("system", null), now)).toBeNull();
  });

  it("dates a downgrade at the earliest of the scheduled cancel, the period end and today", () => {
    const immediate = planMove(row("pro", "2026-09-30T00:00:00Z"), row("free", null), now);
    expect(immediate?.values("en", "Acme").date).toBe("September 8, 2026");
    const scheduled = planMove(
      row("pro", "2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"),
      row("free", null),
      now,
    );
    expect(scheduled?.values("en", "Acme").date).toBe("September 1, 2026");
    const lapsed = planMove(
      row("scale", "2026-08-30T00:00:00Z"),
      row("free", "2026-08-30T00:00:00Z"),
      now,
    );
    expect(lapsed?.values("pt-BR", "Acme")).toMatchObject({
      plan: "Scale 550K",
      date: "30 de agosto de 2026",
      freeCap: "100",
    });
  });
});

describe("mailPreferenceOf", () => {
  it("folds severity steps and the identity variant into one switch, and names none for mail that is always sent", () => {
    expect(mailPreferenceOf("quota.warning")).toBe("quota");
    expect(mailPreferenceOf("deliverability.paused")).toBe("deliverability");
    expect(mailPreferenceOf("domain.lost.identity")).toBe("domain.lost");
    expect(mailPreferenceOf("billing.downgraded")).toBe("billing.downgraded");
    const always = [
      "welcome",
      "password_changed",
      "mcp.connected",
      "api_key.created",
      "webhook.secret_rotated",
      "password_reset",
      "region.paused",
    ] as const;
    for (const kind of always) expect(mailPreferenceOf(kind), kind).toBeNull();
  });
});
