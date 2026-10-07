import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import enCorreio from "../messages/en/correio.json";
import enLanding from "../messages/en/landing.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptLanding from "../messages/pt-BR/landing.json";

type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "en" as Locale }));

// Only shared client chrome is isolated; the page, its sections and real catalogs render.
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "correio" | "landing") =>
    createTranslator({
      locale: current.locale,
      messages:
        current.locale === "pt-BR"
          ? { correio: ptCorreio, landing: ptLanding }
          : { correio: enCorreio, landing: enLanding },
      namespace,
    }),
}));

const { default: CorreioPage, generateMetadata } = await import("@/app/correio/page");

function textContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function section(html: string, labelledBy: string): string {
  const match = html.match(new RegExp(`<section\\b[^>]*aria-labelledby="${labelledBy}"[^>]*>`));
  expect(match, `Expected a labelled section for ${labelledBy}`).not.toBeNull();
  if (!match || match.index === undefined) {
    throw new Error(`Missing section ${labelledBy}`);
  }
  const start = match.index + match[0].length;
  const boundaries = /<\/?section\b[^>]*>/g;
  boundaries.lastIndex = start;
  let depth = 1;
  for (const boundary of html.matchAll(boundaries)) {
    depth += boundary[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, boundary.index);
    }
  }
  throw new Error(`Unclosed section ${labelledBy}`);
}

function capture(match: readonly (string | undefined)[], group: number): string {
  const value = match[group];
  if (value === undefined) {
    throw new Error(`Missing rendered HTML capture ${group}`);
  }
  return value;
}

function links(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: capture(match, 1),
    text: textContent(capture(match, 2)),
  }));
}

const expectations = {
  en: {
    open: /Open to every paying Send subscriber/,
    closed: /Launch preview · closed access/,
    fictional: /fictional content/,
    noMessageSent: /No message was sent/,
    everyPayingPlan: /available on every paying Send plan/i,
    subscribeInDashboard: /Subscribe from the dashboard once your Send plan is active/,
    minimumPlan: /Send plan above US\$\s*20\/month/,
    recurringEligibility:
      /US\$29 Pro 110K offer qualifies even during its US\$20 first monthly bill/,
    legacyPreserved: /Existing US\$20 contracts keep their price/,
    authorizedEarlierPlan:
      /earlier accounts authorized for Mail may keep their current Send plan when adding mailboxes/,
    systemUnlimited:
      /System[\s\S]*50 GiB per mailbox[\s\S]*no commercial mailbox or delivery limits/i,
    paidSeparately: /Mail is paid separately/,
    sendOnly: "Send only",
    combined: "Send + Mail",
    contractsPreserved: /existing subscriptions are preserved/i,
    annualUpfront: "Annual · paid upfront",
    previewStatus: /Price comparison · subscribe in the dashboard/,
    firstPayment: "First monthly bill for new customers:",
    renewal: "Renewal:",
    introRestricted:
      /US\$20 only for the first monthly Send bill of customers who never paid MepMail; then US\$29\/month/,
    mailNoDiscount: /Mail does not receive this discount/,
    recipientAccounting: /To and Cc count; this is not a limit on distinct contacts/,
    noSubscriptionChange: /does not purchase a plan or change your subscription/,
    rest: "Mail · REST API",
    dedicatedKey: /a key dedicated to the mailbox/,
    apiAvailable: "Available for activated mailboxes",
    mcp: "Send · MCP",
    noMailboxAccess: /does not grant access to Mail mailboxes/,
    mcpAvailable: "Available in Send",
    publicMailboxMcpPending: /A public MCP for mailboxes is not available yet/,
    agentFragment: "connect-an-agent",
    docsPrefix: "https://docs-mepmail.je4ndev.com",
  },
  "pt-BR": {
    open: /Aberto a todos os assinantes pagantes de Envio/,
    closed: /Prévia de lançamento · acesso fechado/,
    fictional: /conteúdo fictício/,
    noMessageSent: /Nenhuma mensagem foi enviada/,
    everyPayingPlan: /disponível em todos os planos pagos de Envio/i,
    subscribeInDashboard: /Contrate pelo painel quando o seu plano de Envio estiver ativo/,
    minimumPlan: /plano de Envio acima de US\$ 20\/mês/,
    recurringEligibility:
      /oferta Pro 110K de US\$ 29 qualifica mesmo na primeira mensalidade promocional de US\$ 20/,
    legacyPreserved: /Contratos antigos de US\$ 20 mantêm o preço/,
    authorizedEarlierPlan:
      /contas anteriores autorizadas para o Correio podem manter o plano atual de Envio ao adicionar caixas/,
    systemUnlimited: /System[\s\S]*50 GiB por caixa[\s\S]*sem limites comerciais/i,
    paidSeparately: /Correio é pago à parte/,
    sendOnly: "Só Envio",
    combined: "Envio + Correio",
    contractsPreserved: /assinaturas atuais são preservadas/i,
    annualUpfront: "Anual · antecipado",
    previewStatus: /Comparação de preços · contrate pelo painel/,
    firstPayment: "Primeira mensalidade para novos clientes:",
    renewal: "Renovação:",
    introRestricted:
      /US\$ 20 só na primeira mensalidade de Envio de quem nunca pagou o MepMail; depois US\$ 29\/mês/,
    mailNoDiscount: /Correio não recebe esse desconto/,
    recipientAccounting: /To e Cc contam; não é limite de contatos diferentes/,
    noSubscriptionChange: /não contrata um plano nem altera sua assinatura/,
    rest: "Correio · API REST",
    dedicatedKey: /uma chave dedicada à caixa/,
    apiAvailable: "Disponível para caixas ativadas",
    mcp: "Envio · MCP",
    noMailboxAccess: /não concede acesso às caixas do Correio/,
    mcpAvailable: "Disponível no Envio",
    publicMailboxMcpPending: /Um MCP público para caixas ainda não está disponível/,
    agentFragment: "conecte-um-agente",
    docsPrefix: "https://docs-mepmail.je4ndev.com/pt-BR",
  },
};

async function render(locale: Locale): Promise<string> {
  current.locale = locale;
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages:
        locale === "pt-BR"
          ? { correio: ptCorreio, landing: ptLanding }
          : { correio: enCorreio, landing: enLanding },
      // biome-ignore lint/correctness/noChildrenProp: This provider requires children in its createElement props type.
      children: await CorreioPage(),
    }),
  );
}

describe.each(["en", "pt-BR"] as const)("Correio closed preview fallback in %s", (locale) => {
  afterEach(() => vi.unstubAllEnvs());
  it("still presents a closed, unindexed preview when the opening flag is off", async () => {
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "false");
    const html = await render(locale);
    expect(textContent(section(html, "correio-title"))).toMatch(expectations[locale].closed);
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: true });
  });
});

describe.each(["en", "pt-BR"] as const)("Correio launch presentation in %s", (locale) => {
  const expected = expectations[locale];
  let html: string;

  beforeEach(async () => {
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
    html = await render(locale);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("presents the open offer and labels the conversation example as fictional", () => {
    const hero = section(html, "correio-title");
    const visible = textContent(hero);
    expect(visible).toMatch(expected.open);
    expect(visible).toMatch(expected.fictional);
    expect(visible).toMatch(expected.noMessageSent);
    expect(hero.match(/<h1\b/g)).toHaveLength(1);
    expect(links(hero)).toEqual([
      { href: "#como-funciona", text: expect.any(String) },
      { href: "/pricing", text: expect.any(String) },
    ]);
    expect(links(hero).every((link) => link.text.length > 0)).toBe(true);
    expect(html).toContain('id="como-funciona"');
  });

  it("opens Mail to every paying Send plan as a separately paid add-on", () => {
    const plans = textContent(section(html, "correio-plans-title"));
    expect(plans).toMatch(expected.everyPayingPlan);
    expect(plans).toMatch(expected.subscribeInDashboard);
    expect(plans).toMatch(expected.paidSeparately);
  });

  it("qualifies Mail by the recurring base while preserving old contracts and internal System access", () => {
    const plansHtml = section(html, "correio-plans-title");
    const plans = textContent(plansHtml);
    expect(plans).toMatch(expected.minimumPlan);
    expect(plans).toMatch(expected.recurringEligibility);
    expect(plans).toMatch(expected.legacyPreserved);
    expect(plans).toMatch(expected.authorizedEarlierPlan);
    expect(textContent(html)).toMatch(expected.systemUnlimited);
  });

  it("keeps the mailbox REST API distinct from the Send MCP", () => {
    const integrationHtml = section(html, "correio-integrations-title");
    const articles = [...integrationHtml.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(
      (match) => textContent(capture(match, 1)),
    );
    const api = articles.find((article) => article.includes(expected.rest));
    const mcp = articles.find((article) => article.includes(expected.mcp));
    expect(api).toBeDefined();
    expect(api).toMatch(expected.dedicatedKey);
    expect(api).toContain(expected.apiAvailable);
    expect(mcp).toBeDefined();
    expect(mcp).toMatch(expected.noMailboxAccess);
    expect(mcp).toContain(expected.mcpAvailable);
    expect(textContent(integrationHtml)).toMatch(expected.publicMailboxMcpPending);
  });

  it("sends Mail purchases to the dashboard instead of a checkout on the public page", () => {
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
    expect(main).toBeDefined();
    const content = main ?? "";
    expect(content).not.toMatch(/<form\b/);
    const buttons = [...content.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    expect(buttons.every((button) => button.includes('type="button"'))).toBe(true);
    const inputs = [...content.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((input) => /type="(?:radio|number|checkbox)"/.test(input))).toBe(true);
    for (const link of links(content)) {
      expect(link.href).not.toMatch(/checkout|subscribe|signup|\/settings\/billing/);
      expect(
        ["#como-funciona", "/pricing", "/integrations", "/mail"].includes(link.href) ||
          link.href.startsWith(`${expected.docsPrefix}/`),
      ).toBe(true);
    }
    expect(links(content).some((link) => link.href === "/mail")).toBe(true);
    const closeLinks = links(section(html, "correio-close-title"));
    expect(closeLinks.map((link) => link.href)).toEqual([
      "/pricing",
      `${expected.docsPrefix}/mailboxes`,
    ]);
    expect(closeLinks.every((link) => link.text.length > 0)).toBe(true);
  });

  it("labels an annual upfront option and points purchases to the dashboard while preserving contracts", () => {
    const plansHtml = section(html, "correio-plans-title");
    const plans = textContent(plansHtml);
    const table = plansHtml.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
    expect(table).toBeDefined();
    const columnHeaders = [...(table ?? "").matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map(
      (match) => textContent(capture(match, 1)),
    );
    expect(columnHeaders.slice(1)).toEqual([expected.sendOnly, expected.combined]);
    expect(plans).toMatch(expected.contractsPreserved);
    expect(plans).toContain(expected.annualUpfront);
    expect(plans).toMatch(expected.previewStatus);
    expect(plans).toMatch(expected.noSubscriptionChange);
    expect(plansHtml).toMatch(/<input\b[^>]*checked=""[^>]*value="month"/);
    expect(plansHtml).toMatch(/<input\b[^>]*value="year"/);
    expect(plansHtml).not.toMatch(/<input\b[^>]*checked=""[^>]*value="year"/);
  });

  it("shows the approved new-customer first bill separately from renewal with the Mail add-on undiscounted", () => {
    const plansHtml = section(html, "correio-plans-title");
    const previewLabel = plansHtml.match(
      /<section\b[^>]*class="correio-preview"[^>]*aria-labelledby="([^"]+)"/,
    );
    const previewHtml = section(plansHtml, capture(previewLabel ?? [], 1));
    const preview = textContent(previewHtml);
    const articles = [...previewHtml.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(
      (match) => textContent(capture(match, 1)),
    );
    const sending = articles.find((article) => article.startsWith(expected.sendOnly));
    const combined = articles.find((article) => article.startsWith(expected.combined));
    expect(sending).toBeDefined();
    expect(combined).toBeDefined();
    const currency = (cents: number) =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: LAUNCH_OFFER.currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
        .format(cents / 100)
        .replace(/\s+/g, " ");
    const mailbox = LAUNCH_OFFER.mailboxes[0];
    expect(sending).toContain(
      `${expected.firstPayment} ${currency(LAUNCH_OFFER.sending.firstMonthlyCents)}`,
    );
    expect(sending).toContain(`${expected.renewal} ${currency(LAUNCH_OFFER.sending.monthlyCents)}`);
    expect(combined).toContain(
      `${expected.firstPayment} ${currency(LAUNCH_OFFER.sending.firstMonthlyCents + mailbox.monthlyCents)}`,
    );
    expect(combined).toContain(
      `${expected.renewal} ${currency(LAUNCH_OFFER.sending.monthlyCents + mailbox.monthlyCents)}`,
    );
    expect(sending).toContain(
      new Intl.NumberFormat(locale).format(LAUNCH_OFFER.sending.monthlyRecipientDeliveries),
    );
    expect(combined).toContain(
      new Intl.NumberFormat(locale).format(mailbox.monthlyRecipientDeliveries),
    );
    expect(combined).toMatch(expected.recipientAccounting);
    expect(preview).toMatch(expected.introRestricted);
    expect(preview).toMatch(expected.mailNoDiscount);
    for (const option of LAUNCH_OFFER.mailboxes) {
      expect(preview).toContain(`${option.storageGiB} GiB`);
      expect(previewHtml).toMatch(new RegExp(`<input\\b[^>]*value="${option.id}"`));
    }
  });

  it("gives preview radio groups labels, legends and exactly one initial selection", () => {
    const plans = section(html, "correio-plans-title");
    const fieldsets = [...plans.matchAll(/<fieldset\b[^>]*>([\s\S]*?)<\/fieldset>/g)].map((match) =>
      capture(match, 1),
    );
    expect(fieldsets.length).toBeGreaterThanOrEqual(2);
    const groupNames = new Set<string>();
    for (const fieldset of fieldsets) {
      const legend = fieldset.match(/<legend\b[^>]*>([\s\S]*?)<\/legend>/);
      expect(legend).not.toBeNull();
      expect(textContent(capture(legend ?? [], 1)).length).toBeGreaterThan(0);
      const labelledOptions = [...fieldset.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map(
        (match) => capture(match, 1),
      );
      const radioOptions = labelledOptions.filter((option) =>
        /<input\b[^>]*type="radio"/.test(option),
      );
      if (radioOptions.length === 0) continue;
      expect(radioOptions.length).toBeGreaterThanOrEqual(2);
      expect(radioOptions.every((option) => textContent(option).length > 0)).toBe(true);
      const names = radioOptions.map((option) => capture(option.match(/name="([^"]+)"/) ?? [], 1));
      expect(new Set(names).size).toBe(1);
      const name = names[0];
      if (name === undefined) throw new Error("Preview radio group has no name");
      expect(groupNames.has(name)).toBe(false);
      groupNames.add(name);
      expect(radioOptions.filter((option) => /<input\b[^>]*checked=""/.test(option))).toHaveLength(
        1,
      );
    }
    expect(groupNames.size).toBeGreaterThanOrEqual(2);
    expect(plans).toContain('aria-live="polite"');
    expect(plans).toContain('aria-atomic="true"');
  });

  it("labels mailbox quantity and associates its bounded comparison range with readable help", () => {
    const plans = section(html, "correio-plans-title");
    const quantity = plans.match(/<input\b[^>]*type="number"[^>]*>/);
    const input = capture(quantity ?? [], 0);
    const id = capture(input.match(/\bid="([^"]+)"/) ?? [], 1);
    const label = [...plans.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)].find(
      (match) => capture(match, 1) === id,
    );
    expect(textContent(capture(label ?? [], 2)).length).toBeGreaterThan(0);
    expect(input).toContain(`min="${LAUNCH_OFFER.previewMailboxQuantity.min}"`);
    expect(input).toContain(`max="${LAUNCH_OFFER.previewMailboxQuantity.max}"`);
    expect(input).toContain('step="1"');
    expect(input).toContain('value="1"');
    expect(input).toContain('aria-invalid="false"');
    const hintId = capture(input.match(/aria-describedby="([^"]+)"/) ?? [], 1);
    const hint = [...plans.matchAll(/<p\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g)].find(
      (match) => capture(match, 1) === hintId,
    );
    expect(textContent(capture(hint ?? [], 2))).toMatch(/1[\s\S]*50/);
  });

  it("links to the matching language for domain, Mail and MCP documentation", () => {
    const docLinks = links(html)
      .map((link) => link.href)
      .filter((href) => href.startsWith("https://docs-mepmail.je4ndev.com"));
    expect(new Set(docLinks)).toEqual(
      new Set([
        `${expected.docsPrefix}/concepts/domains`,
        `${expected.docsPrefix}/mailboxes`,
        `${expected.docsPrefix}/mcp`,
        `${expected.docsPrefix}/mailboxes#${expected.agentFragment}`,
      ]),
    );
  });

  it("indexes the open offer with localized metadata", async () => {
    const metadata = await generateMetadata();
    const copy = locale === "pt-BR" ? ptCorreio : enCorreio;
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("/correio");
    expect(metadata.title).toEqual({ absolute: copy.meta.title });
    expect(metadata.description).toBe(copy.meta.description);
    expect(metadata.openGraph).toMatchObject({
      title: copy.meta.title,
      description: copy.meta.description,
      url: "/correio",
    });
  });
});
