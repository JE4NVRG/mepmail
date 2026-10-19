import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MCP_SERVER_VERSION } from "../../../packages/core/src/mcp-server-card";
import { OVERAGE_HARD_CAP, PLAN_RUNGS, QUOTA_TOLERANCE } from "../../../packages/core/src/plans";
import { formatBrlPrice, PRICE_ROWS, resendQuote } from "../src/lib/landing-pricing";
import { LAUNCH_OFFER } from "../src/lib/launch-offer";

/**
 * One rule for limits, queues and overage across the public pages (Helm review, 19/10): the
 * pricing FAQ answer is the text, the other pages repeat it word for word, and every number
 * in it comes from the code. Also the terms covering Mail, and wording the review asked out.
 */
const web = fileURLToPath(new URL("..", import.meta.url));
const docs = join(web, "../docs/content/docs");
const core = join(web, "../../packages/core/src");
const LOCALES = ["en", "pt-BR"] as const;
type Locale = (typeof LOCALES)[number];

const messages = (locale: Locale, file: string) =>
  JSON.parse(readFileSync(join(web, "messages", locale, `${file}.json`), "utf8"));
const backlogDays = Number(
  /export const QUOTA_BACKLOG_DAYS = (\d+);/.exec(
    readFileSync(join(core, "accept-email.ts"), "utf8"),
  )?.[1],
);
const brl = (cents: number) => formatBrlPrice(cents, "pt-BR");
/** A numeric constant of a core source file, read as text (no database imports in this test). */
function coreNumber(file: string, name: string): number {
  const match = new RegExp(`export const ${name} = ([\\d.]+);`).exec(
    readFileSync(join(core, file), "utf8"),
  );
  if (!match) throw new Error(`${name} not found in ${file}`);
  return Number(match[1]);
}

function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === "object") return Object.values(node).flatMap(strings);
  return [];
}

describe("one overage rule on every public page", () => {
  it.each(LOCALES)("repeats the pricing FAQ answer word for word (%s)", (locale) => {
    const pricing = messages(locale, "pricing");
    const rule = pricing.faq.items[0].a as string;
    expect(pricing.launchFaq[0].a).toBe(rule);
    expect(messages(locale, "envio").faq.items[1].a).toBe(rule);
  });

  it.each(LOCALES)("takes every number of the rule from the code (%s)", (locale) => {
    const rule = messages(locale, "pricing").faq.items[0].a as string;
    expect(backlogDays).toBe(3);
    expect(rule).toContain(`${QUOTA_TOLERANCE * 100}%`);
    expect(rule).toContain(`${backlogDays}×`);
    expect(rule).toContain(`${OVERAGE_HARD_CAP}×`);
    // 5× in total is the included volume plus up to 4× billed as overage.
    expect(rule).toContain(`${OVERAGE_HARD_CAP - 1}×`);
    const annual = LAUNCH_OFFER.annualChargedMonths;
    expect(rule).toContain(
      locale === "en"
        ? `US$ ${(LAUNCH_OFFER.sending.monthlyCents * annual) / 100}`
        : brl(LAUNCH_OFFER.sending.brlMonthlyCents * annual),
    );
    // The alternatives page states the same queue: the same tolerance and backlog.
    const alternative = messages(locale, "alternatives").different.items[2] as string;
    expect(alternative).toContain(`${QUOTA_TOLERANCE * 100}%`);
    expect(alternative).toContain(`${backlogDays}×`);
  });

  it.each(LOCALES)(
    "names the annual plan wherever the FAQ says plans are monthly (%s)",
    (locale) => {
      for (const text of strings([messages(locale, "envio"), messages(locale, "landing")]))
        expect(text).not.toMatch(/^No\. Plans are monthly/);
    },
  );

  it("states the rung prices of the docs Billing table from PLAN_RUNGS", () => {
    for (const [file, locale] of [
      ["billing.mdx", "en-US"],
      ["billing.pt-BR.mdx", "pt-BR"],
    ] as const) {
      const page = readFileSync(join(docs, file), "utf8");
      for (const rung of PLAN_RUNGS) {
        const row = page.split("\n").find((line) => line.startsWith(`| \`${rung.key}\``));
        expect(row, `${file} ${rung.key}`).toBeDefined();
        const reais = `R$ ${(
          (rung.key === "pro_100k" ? LAUNCH_OFFER.sending.brlMonthlyCents : rung.brlPriceCents) /
            100
        ).toLocaleString(locale)}`;
        expect(row, `${file} ${rung.key}`).toContain(reais);
        if (rung.brlOverageCentsPer1k !== null)
          expect(row, `${file} ${rung.key}`).toContain(
            `R$ ${(rung.brlOverageCentsPer1k / 100).toLocaleString(locale, { minimumFractionDigits: 2 })}`,
          );
      }
    }
  });

  it("prices the pt-BR guide's Pro in reais", () => {
    const guide = strings(messages("pt-BR", "guides")).find((text) => text.includes("O Pro envia"));
    expect(guide).toContain(brl(LAUNCH_OFFER.sending.brlMonthlyCents));
  });
});

describe("Resend comparison", () => {
  it("computes each row from Resend's published plans, overage included", () => {
    expect(PRICE_ROWS.map((row) => row.resend)).toEqual([44, 143, 385, 715, 903, 1265]);
    // 110K is the 100K plan plus 10K of overage, not the 100K plan's US$ 35 alone.
    expect(resendQuote(110_000)).toEqual({
      plan: "Pro 100K",
      base: 35,
      extra: 10_000,
      overagePer1k: 0.9,
      total: 44,
    });
    expect(resendQuote(100_000)).toMatchObject({ plan: "Pro 100K", extra: 0, total: 35 });
  });
});

describe("terms and wording", () => {
  it.each(LOCALES)("covers Mail in the terms, with reais and Pix (%s)", (locale) => {
    const terms = JSON.stringify(messages(locale, "legal").terms);
    expect(terms).toContain(locale === "en" ? "Mail" : "Correio");
    expect(terms).toContain("Pix");
    expect(terms).toContain("reais");
    expect(terms).toContain(`${backlogDays}×`);
  });

  it("keeps “drop-in” and “team building” out of the site and the docs", () => {
    const texts = [
      ...LOCALES.flatMap((locale) =>
        readdirSync(join(web, "messages", locale)).map((file) =>
          readFileSync(join(web, "messages", locale, file), "utf8"),
        ),
      ),
      ...readdirSync(docs, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".mdx"))
        .map((file) => readFileSync(join(docs, file), "utf8")),
    ];
    for (const text of texts) expect(text).not.toMatch(/drop-in|team building/i);
  });

  it("links the Portuguese docs from the Portuguese pages", () => {
    for (const file of readdirSync(join(web, "messages", "pt-BR"))) {
      for (const text of strings(messages("pt-BR", file.replace(/\.json$/, "")))) {
        for (const [url] of text.matchAll(/https:\/\/docs\.mepmail\.dev\/[^\s"'<>)]*/g))
          expect(url, file).toMatch(/^https:\/\/docs\.mepmail\.dev\/(pt-BR|llms|openapi|prompts)/);
      }
    }
  });

  it.each(LOCALES)(
    "lists on the security page every provider the privacy policy names (%s)",
    (locale) => {
      const security = messages(locale, "security");
      const providers = (security.subprocessors.rows as { provider: string }[]).map(
        (row) => row.provider,
      );
      const privacy = messages(locale, "legal").privacy.sections.find(
        (section: { title: string }) => section.title.startsWith("7."),
      ) as { list: string[] };
      // Each privacy entry starts with the provider's name, up to " (" or " —".
      for (const entry of privacy.list.filter((item) => !item.startsWith("Telegram"))) {
        const name = entry
          .split(/ \(| — /)[0]!
          .split(" and ")[0]!
          .split(" e ")[0]!;
        const word = name.replace(/^Domain-registration |^Operadores /, "").split(" ")[0]!;
        expect(
          providers.some((provider) => provider.includes(word)),
          `${locale}: ${word}`,
        ).toBe(true);
      }
      // The abuse check is on in production: the page must not say no AI provider sees content.
      expect(JSON.stringify(security)).not.toMatch(
        /No AI provider processes|Nenhum provedor de IA processa|runs with it off|roda com ela desligada/,
      );
    },
  );

  it.each(LOCALES)(
    "states the guardrail lines of deliverability.ts in the support FAQ (%s)",
    (locale) => {
      const pct = (rate: number) =>
        `${(rate * 100).toLocaleString(locale === "en" ? "en-US" : "pt-BR")}%`;
      const answer = strings(messages(locale, "support").faq.items).find((text) =>
        text.includes(pct(coreNumber("deliverability.ts", "PAUSE_COMPLAINT_RATE"))),
      );
      expect(answer, locale).toBeDefined();
      for (const rate of ["PAUSE_BOUNCE_RATE", "WARN_BOUNCE_RATE", "WARN_COMPLAINT_RATE"])
        expect(answer).toContain(pct(coreNumber("deliverability.ts", rate)));
      for (const count of [
        "MIN_PAUSE_HARD_BOUNCES",
        "MIN_PAUSE_COMPLAINTS",
        "MIN_GUARDRAIL_VOLUME",
      ])
        expect(answer).toContain(String(coreNumber("deliverability.ts", count)));
      expect(answer).toContain(String(coreNumber("deliverability.ts", "GUARDRAIL_WINDOW_DAYS")));
      // No SLA is promised; the status page is linked.
      const status = messages(locale, "support").faq.items.find(
        (item: { link: { href: string } }) => item.link.href === "/status",
      );
      expect(status?.a).toMatch(locale === "en" ? /no SLA/ : /Não há SLA/);
    },
  );

  it("publishes the receiving MX the code expects on the Domains pages", () => {
    const expected = /mxExchange: "([^"]+)"/.exec(
      readFileSync(join(web, "src/server/mailbox-receiving.ts"), "utf8"),
    )?.[1];
    expect(expected).toBe("inbound-smtp.us-east-1.amazonaws.com");
    for (const file of ["concepts/domains.mdx", "concepts/domains.pt-BR.mdx"])
      expect(readFileSync(join(docs, file), "utf8")).toContain(`\`${expected}\``);
  });

  it("states the hosted MCP version the registry lists on the Packages pages", () => {
    for (const file of ["packages.mdx", "packages.pt-BR.mdx"])
      expect(readFileSync(join(docs, file), "utf8")).toContain(`**${MCP_SERVER_VERSION}**`);
  });
});
