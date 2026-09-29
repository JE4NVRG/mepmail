/**
 * Renders EVERY transactional email the instance can send into a local
 * gallery for review: one HTML file per template plus an index.html with all
 * of them side by side (pt-BR first, en behind a detail toggle).
 *
 * Off by default: run with MAIL_GALLERY=1 and pass this file explicitly:
 *   cd apps/web && MAIL_GALLERY=1 pnpm exec vitest run test/mail-gallery.gen.test.ts
 *
 * Output: /home/jean/.hermes/cache/scratch/mail-gallery/
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_MAIL_KINDS, buildAccountMail } from "@millionsend/core";
import { describe, expect, it } from "vitest";
import {
  buildInvitationEmail,
  buildResetEmail,
  buildUpdatesConfirmEmail,
  buildVerificationEmail,
} from "@/server/system-mail";

const OUT = "/home/jean/.hermes/cache/scratch/mail-gallery";
const LOCALES = ["pt-BR", "en"] as const;
const SAMPLE_URL = "https://mepmail.je4ndev.com/sample?token=EXEMPLO";

/** Realistic stand-ins for every {slot} in the account catalogs. */
const VALUES: Record<string, string> = {
  name: "Jean",
  team: "Vultrix3D",
  plan: "Pro 220K",
  date: "15 de outubro de 2026",
  cap: "até 220.000 e-mails por mês",
  freeCap: "100",
  app: "Claude (MCP)",
  scopes: "Enviar e-mails, Ler o status de entrega",
  email: "jean@je4ndev.com",
  role: "Administrador",
  inviter: "Jean Carlos",
  inviterName: "Jean Carlos",
  days: "7",
  minutes: "30",
  hours: "24",
  docsUrl: "https://docs-mepmail.je4ndev.com",
  domain: "mail.vultrix3d.com.br",
  reason: "bounce rate acima de 5%",
  metric: "7,4%",
  threshold: "5%",
  count: "1.284",
  limit: "100",
  subject: "Pedido #4821",
  environment: "produção",
  endpoint: "https://api.vultrix3d.com.br/webhooks/mepmail",
  failures: "12",
  window: "24 horas",
  host: "webhooks.vultrix3d.com.br",
  old: "Starter",
  new: "Pro 220K",
  parked: "37",
  rate: "12%",
  actor: "Jean Carlos",
  billingUrl: "https://mepmail.je4ndev.com/settings/billing",
  emails: "3 e-mails",
  failed: " 37 falharam.",
  first: "640",
  flagged: "9",
  last4: "4821",
  model: "judge-1.2",
  operator: "Luna",
  permission: "acesso de envio",
  scope: ", escopo emails:send",
  prefix: "ms_9f2a",
  provider: "Alibaba Bailian",
  region: "us-east-1",
  retry: "Vamos tentar de novo automaticamente em 3 dias.",
  risk: "0,82",
  samples: "412",
  score: "0,91",
  sent: "1.247",
  tier: "alto",
  unjudged: "18",
  url: "https://api.vultrix3d.com.br/webhooks/mepmail",
};

/** The base map, in each language, plus the kinds whose slots mean something else. */
const LOCALE_VALUES: Record<(typeof LOCALES)[number], Record<string, string>> = {
  "pt-BR": {
    date: "15 de outubro de 2026",
    cap: "até 220.000 e-mails por mês",
    deadline: "O segredo antigo continua válido até 15 de outubro de 2026 às 14:00 UTC.",
    finishesAt: "20 de outubro de 2026, 14:00 UTC",
    until: "20 de outubro de 2026, 14:00 UTC",
    when: "27 de setembro de 2026, 19:20 UTC",
    release:
      "Quando a cota do novo período abrir, os e-mails parados saem sozinhos — nada precisa ser feito.",
  },
  en: {
    date: "October 15, 2026",
    cap: "up to 220,000 emails a month",
    deadline: "The old secret stays valid until October 15, 2026 at 14:00 UTC.",
    finishesAt: "October 20, 2026, 14:00 UTC",
    until: "October 20, 2026, 14:00 UTC",
    when: "September 27, 2026, 19:20 UTC",
    failed: " 37 failed.",
    emails: "3 emails",
    release:
      "When the new period's quota opens, the parked emails go out on their own — nothing to do.",
  },
};

const KIND_VALUES: Record<string, Record<string, string>> = {
  broadcast: { name: "Newsletter de outubro" },
  support: { reason: "uma verificação de segurança" },
  content: { reason: "uma denúncia de abuso" },
};

function slotsOf(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

/** Fill any slot the VALUES map missed with a visible marker (and report it). */
const missing = new Set<string>();
function valuesFor(
  kind: string,
  locale: (typeof LOCALES)[number],
  ...texts: string[]
): Record<string, string> {
  const stem = kind.split(".")[0] as string;
  const out: Record<string, string> = {
    ...VALUES,
    ...LOCALE_VALUES[locale],
    ...(KIND_VALUES[stem] ?? {}),
  };
  for (const t of texts) {
    for (const slot of slotsOf(t)) {
      if (!(slot in out)) {
        missing.add(slot);
        out[slot] = `‹${slot}›`;
      }
    }
  }
  return out;
}

interface Rendered {
  group: string;
  label: string;
  kind: string;
  locale: string;
  subject: string;
  html: string;
}

const GROUPS: Record<string, string> = {
  welcome: "Conta & boas-vindas",
  password_changed: "Conta & boas-vindas",
  mcp: "Conta & boas-vindas",
  api_key: "Conta & boas-vindas",
  webhook: "Conta & boas-vindas",
  member: "Conta & boas-vindas",
  invitation: "Conta & boas-vindas",
  updates: "Conta & boas-vindas",
  email_verification: "Segurança & recuperação",
  password_reset: "Segurança & recuperação",
  billing: "Cobrança",
  broadcast: "Broadcasts & limites",
  domain: "Domínios",
  team: "Operação",
  monitor: "Operação",
  content: "Operação",
  support: "Operação",
};

function groupOf(kind: string): string {
  const stem = kind.split(".")[0] as string;
  return GROUPS[stem] ?? "Outros";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

describe.skipIf(process.env.MAIL_GALLERY !== "1")("mail gallery generator", () => {
  it("writes every template and the index", () => {
    const rendered: Rendered[] = [];

    // --- Account catalogs: every kind, both locales -----------------------
    for (const locale of LOCALES) {
      for (const kind of ACCOUNT_MAIL_KINDS) {
        // First pass with no values to learn the slots, second with data.
        const probe = buildAccountMail({ kind, locale, url: SAMPLE_URL, values: {} });
        const mail = buildAccountMail({
          kind,
          locale,
          url: SAMPLE_URL,
          values: valuesFor(kind, locale, probe.subject, probe.text),
        });
        rendered.push({
          group: groupOf(kind),
          label: kind,
          kind,
          locale,
          subject: mail.subject,
          html: mail.html,
        });
      }
    }

    // --- Auth & team mails with dedicated builders ------------------------
    for (const locale of LOCALES) {
      const probeR = buildResetEmail({ to: "x@x", name: "x", url: SAMPLE_URL, locale });
      const reset = buildResetEmail({
        to: "jean@je4ndev.com",
        name: "Jean",
        url: SAMPLE_URL,
        locale,
      });
      rendered.push({
        group: groupOf("password_reset"),
        label: "password_reset",
        kind: "password_reset",
        locale,
        subject: reset.subject,
        html: reset.html,
      });
      void probeR;

      const verify = buildVerificationEmail({
        to: "jean@je4ndev.com",
        name: "Jean",
        url: SAMPLE_URL,
        locale,
      });
      rendered.push({
        group: groupOf("email_verification"),
        label: "email_verification",
        kind: "email_verification",
        locale,
        subject: verify.subject,
        html: verify.html,
      });

      const updates = buildUpdatesConfirmEmail({ to: "jean@je4ndev.com", url: SAMPLE_URL, locale });
      rendered.push({
        group: groupOf("updates"),
        label: "updates.confirm",
        kind: "updates.confirm",
        locale,
        subject: updates.subject,
        html: updates.html,
      });

      const invite = buildInvitationEmail({
        to: "novo@exemplo.com",
        inviterName: "Jean Carlos",
        teamName: "Vultrix3D",
        role: "member",
        url: SAMPLE_URL,
        expiresInDays: 7,
        locale,
      });
      rendered.push({
        group: groupOf("invitation"),
        label: "invitation",
        kind: "invitation",
        locale,
        subject: invite.subject,
        html: invite.html,
      });
    }

    // --- Write files ------------------------------------------------------
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(join(OUT, "html"), { recursive: true });
    for (const r of rendered) {
      writeFileSync(join(OUT, "html", `${r.locale}__${r.label}.html`), r.html, "utf8");
    }

    // --- Index ------------------------------------------------------------
    const labels = [...new Set(rendered.map((r) => r.label))];
    const groupOrder = [
      "Conta & boas-vindas",
      "Segurança & recuperação",
      "Cobrança",
      "Broadcasts & limites",
      "Domínios",
      "Operação",
      "Outros",
    ];
    const sections: string[] = [];
    for (const group of groupOrder) {
      const inGroup = labels.filter((l) => groupOf(l) === group);
      if (inGroup.length === 0) continue;
      const cards = inGroup
        .map((label) => {
          const pt = rendered.find((r) => r.label === label && r.locale === "pt-BR");
          const en = rendered.find((r) => r.label === label && r.locale === "en");
          const card = (r: Rendered) => `
      <figure class="mail">
        <figcaption>
          <strong>${esc(r.subject)}</strong>
          <span class="meta">${esc(r.locale)} · ${esc(r.label)}</span>
        </figcaption>
        <iframe loading="lazy" title="${esc(r.label)} ${esc(r.locale)}" srcdoc="${esc(r.html)}"></iframe>
      </figure>`;
          return `
    <section class="tpl" data-name="${esc(label.toLowerCase())}">
      <h3>${esc(label)}</h3>
      ${pt ? card(pt) : ""}
      ${en ? `<details><summary>English</summary>${card(en)}</details>` : ""}
    </section>`;
        })
        .join("\n");
      sections.push(`<h2 class="group">${esc(group)}</h2>\n${cards}`);
    }

    const index = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MepMail — Galeria de e-mails transacionais</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 28px 22px 60px;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0b0d10; color: #e7e9ee;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #9aa3b2; margin: 0 0 18px; font-size: 13px; }
  .filter {
    width: 100%; max-width: 420px; box-sizing: border-box;
    padding: 9px 12px; margin-bottom: 22px;
    background: #14171c; color: inherit; border: 1px solid #2a2f37; border-radius: 8px;
  }
  h2.group { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #8ab4ff; margin: 34px 0 14px; }
  .tpl { margin: 0 0 26px; padding: 16px; background: #101318; border: 1px solid #232833; border-radius: 12px; }
  .tpl h3 { margin: 0 0 12px; font-size: 15px; font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #ffd479; }
  figure.mail { margin: 0 0 14px; }
  figcaption { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin-bottom: 8px; }
  figcaption strong { font-size: 13.5px; }
  .meta { color: #7c869a; font-size: 11.5px; font-family: ui-monospace, Menlo, monospace; }
  iframe { width: 100%; height: 470px; border: 1px solid #2a2f37; border-radius: 10px; background: #fff; }
  details summary { cursor: pointer; color: #9aa3b2; font-size: 13px; margin: 4px 0 10px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <h1>MepMail — Galeria de e-mails transacionais</h1>
  <p class="sub">${rendered.length} renders · ${labels.length} templates (pt-BR + EN) · dados de exemplo · gerado em ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</p>
  <input class="filter" type="search" placeholder="Filtrar por template (ex.: billing, welcome, reset…)">
  ${sections.join("\n")}
<script>
  const q = document.querySelector(".filter");
  q.addEventListener("input", () => {
    const v = q.value.trim().toLowerCase();
    for (const s of document.querySelectorAll(".tpl")) {
      s.classList.toggle("hidden", v !== "" && !s.dataset.name.includes(v));
    }
    for (const h of document.querySelectorAll("h2.group")) h.classList.toggle("hidden", v !== "");
  });
</script>
</body>
</html>`;
    writeFileSync(join(OUT, "index.html"), index, "utf8");

    // --- Report -----------------------------------------------------------
    console.log(`gallery: ${rendered.length} renders, ${labels.length} templates -> ${OUT}`);
    if (missing.size > 0) {
      console.log(`slots sem valor de exemplo (marcados ‹…›): ${[...missing].sort().join(", ")}`);
    } else {
      console.log("todos os slots preenchidos com exemplos");
    }
    expect(labels.length).toBeGreaterThanOrEqual(30);
  });
});
