/**
 * Starter template library: ready-made designs a team can copy into its own
 * templates with one click. Pure data + renderers, no DB access — the
 * templates router owns persistence (create / createFromStarter).
 *
 * Conventions mirrored from the rest of the app:
 * - Merge tokens use the exact `{{{NAME|fallback}}}` grammar from
 *   lib/merge-fields.ts (same regex the send worker resolves).
 * - Emails are table-based with inline styles only, no external assets, so a
 *   starter renders identically in the dashboard preview and in any client.
 * - Both launch locales (en, pt-BR) ship for every starter.
 */
import type { AppLocale } from "../i18n/request";

export const STARTER_KEYS = [
  "welcome",
  "verify-email",
  "reset-password",
  "otp-code",
  "order-confirmation",
  "shipping-update",
  "cart-abandonment",
  "receipt",
  "newsletter",
  "winback",
] as const;

export type StarterKey = (typeof STARTER_KEYS)[number];

export type StarterCategory = "onboarding" | "authentication" | "commerce" | "marketing";

export interface StarterMeta {
  key: StarterKey;
  category: StarterCategory;
  /** Localized display name. */
  name: string;
  /** Localized one-line description. */
  description: string;
}

export interface StarterDetail extends StarterMeta {
  subject: string;
  html: string;
  text: string;
}

type Copy = { name: string; description: string; subject: string; html: string; text: string };

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** Shared email shell: light background, 560px card, optional compliance footer. */
function shell(locale: "en" | "pt-BR", preheader: string, inner: string, footer?: string): string {
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title></title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<span style="display:none;font-size:1px;line-height:1px;color:#f4f4f5;max-height:0;max-width:0;overflow:hidden;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr>
<td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
<tr>
<td style="background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;padding:36px 36px 32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#18181b;">
${inner}
</td>
</tr>
${
  footer
    ? `<tr>
<td align="center" style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#71717a;">
${footer}
</td>
</tr>`
    : ""
}
</table>
</td>
</tr>
</table>
</body>
</html>`;
}

/** Dark CTA button, table-based for Outlook. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;">
<tr>
<td style="background:#18181b;border-radius:8px;">
<a href="${url}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;">${label}</a>
</td>
</tr>
</table>`;
}

/** Shared heading + paragraph primitives so every starter reads the same. */
function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:#18181b;">${text}</h1>`;
}
function para(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:#3f3f46;">${text}</p>`;
}
function muted(text: string): string {
  return `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:#71717a;">${text}</p>`;
}
function codeBlock(code: string): string {
  return `<div style="margin:22px 0;padding:16px 20px;background:#f4f4f5;border-radius:8px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;color:#18181b;">${code}</div>`;
}
function itemsTable(rows: [string, string][]): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #f4f4f5;font-family:${FONT};font-size:14px;color:#3f3f46;">${label}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #f4f4f5;font-family:${FONT};font-size:14px;color:#18181b;white-space:nowrap;">${value}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">${body}</table>`;
}

/** Copy of one starter in one locale. */
const STARTERS: Record<
  StarterKey,
  { category: StarterCategory; copies: Record<"en" | "pt-BR", Copy> }
> = {
  welcome: {
    category: "onboarding",
    copies: {
      en: {
        name: "Welcome",
        description: "First hello after sign-up, with three quick starting points.",
        subject: "Welcome — let's get you started",
        html: shell(
          "en",
          "Thanks for signing up. Here's how to get started.",
          `${heading("Welcome, {{{FIRST_NAME|there}}}!")}
${para("Thanks for signing up. Your account is ready — here are three things you can do right away:")}
${itemsTable([
  ["1. Set up your workspace", "Pick a name and invite your team"],
  ["2. Connect your tools", "Follow the 2-minute setup guide"],
  ["3. Send your first email", "Use a ready-made template"],
])}
${button("{{{CTA_URL|https://example.com/start}}}", "Get started")}
${muted("You're receiving this because an account was created with this email address.")}`,
        ),
        text: `Welcome, {{{FIRST_NAME|there}}}!

Thanks for signing up. Your account is ready. Three things you can do right away:

1. Set up your workspace — pick a name and invite your team
2. Connect your tools — follow the 2-minute setup guide
3. Send your first email — use a ready-made template

Get started: {{{CTA_URL|https://example.com/start}}}`,
      },
      "pt-BR": {
        name: "Boas-vindas",
        description: "Primeiro olá após o cadastro, com três pontos de partida rápidos.",
        subject: "Bem-vindo(a) — vamos começar",
        html: shell(
          "pt-BR",
          "Obrigado por se cadastrar. Veja como começar.",
          `${heading("Bem-vindo(a), {{{FIRST_NAME|tudo bem}}}!")}
${para("Obrigado por se cadastrar. Sua conta está pronta — três coisas que você já pode fazer:")}
${itemsTable([
  ["1. Configure seu espaço", "Escolha um nome e convide seu time"],
  ["2. Conecte suas ferramentas", "Siga o guia de configuração de 2 minutos"],
  ["3. Envie seu primeiro e-mail", "Use um modelo pronto"],
])}
${button("{{{CTA_URL|https://example.com/start}}}", "Começar agora")}
${muted("Você recebeu este e-mail porque uma conta foi criada com este endereço.")}`,
        ),
        text: `Bem-vindo(a), {{{FIRST_NAME|tudo bem}}}!

Obrigado por se cadastrar. Sua conta está pronta. Três coisas que você já pode fazer:

1. Configure seu espaço — escolha um nome e convide seu time
2. Conecte suas ferramentas — siga o guia de configuração de 2 minutos
3. Envie seu primeiro e-mail — use um modelo pronto

Começar agora: {{{CTA_URL|https://example.com/start}}}`,
      },
    },
  },

  "verify-email": {
    category: "authentication",
    copies: {
      en: {
        name: "Verify email",
        description: "Double opt-in / address confirmation with a clear CTA.",
        subject: "Confirm your email address",
        html: shell(
          "en",
          "One click to confirm your email address.",
          `${heading("Hi {{{FIRST_NAME|there}}}, please confirm your email")}
${para("Click the button below to confirm this address and activate your account.")}
${button("{{{VERIFY_URL|https://example.com/verify}}}", "Confirm email")}
${para("If the button doesn't work, copy and paste this link into your browser:")}
${muted("{{{VERIFY_URL|https://example.com/verify}}}")}
${muted("Didn't create an account? You can safely ignore this email.")}`,
        ),
        text: `Hi {{{FIRST_NAME|there}}},

Please confirm your email by opening this link:
{{{VERIFY_URL|https://example.com/verify}}}

Didn't create an account? You can safely ignore this email.`,
      },
      "pt-BR": {
        name: "Confirmação de e-mail",
        description: "Opt-in duplo / confirmação de endereço com CTA claro.",
        subject: "Confirme seu e-mail",
        html: shell(
          "pt-BR",
          "Um clique para confirmar seu e-mail.",
          `${heading("Olá, {{{FIRST_NAME|tudo bem}}}! Confirme seu e-mail")}
${para("Clique no botão abaixo para confirmar este endereço e ativar sua conta.")}
${button("{{{VERIFY_URL|https://example.com/verify}}}", "Confirmar e-mail")}
${para("Se o botão não funcionar, copie e cole este link no navegador:")}
${muted("{{{VERIFY_URL|https://example.com/verify}}}")}
${muted("Não criou uma conta? Pode ignorar este e-mail com segurança.")}`,
        ),
        text: `Olá, {{{FIRST_NAME|tudo bem}}}!

Confirme seu e-mail abrindo este link:
{{{VERIFY_URL|https://example.com/verify}}}

Não criou uma conta? Pode ignorar este e-mail com segurança.`,
      },
    },
  },

  "reset-password": {
    category: "authentication",
    copies: {
      en: {
        name: "Password reset",
        description: "Reset link with expiry note and safety guidance.",
        subject: "Reset your password",
        html: shell(
          "en",
          "Use the button below to choose a new password.",
          `${heading("Reset your password")}
${para("Hi {{{FIRST_NAME|there}}} — we received a request to reset the password for your account.")}
${button("{{{RESET_URL|https://example.com/reset}}}", "Choose a new password")}
${muted("This link expires in 30 minutes and can only be used once.")}
${muted("If you didn't request this, ignore this email — your current password stays the same.")}`,
        ),
        text: `Reset your password

Hi {{{FIRST_NAME|there}}} — open this link to choose a new password:
{{{RESET_URL|https://example.com/reset}}}

The link expires in 30 minutes. If you didn't request this, ignore this email.`,
      },
      "pt-BR": {
        name: "Redefinição de senha",
        description: "Link de redefinição com aviso de expiração e segurança.",
        subject: "Redefinir sua senha",
        html: shell(
          "pt-BR",
          "Use o botão abaixo para escolher uma nova senha.",
          `${heading("Redefinir sua senha")}
${para("Olá, {{{FIRST_NAME|tudo bem}}} — recebemos um pedido para redefinir a senha da sua conta.")}
${button("{{{RESET_URL|https://example.com/reset}}}", "Escolher nova senha")}
${muted("Este link expira em 30 minutos e só pode ser usado uma vez.")}
${muted("Se não foi você, ignore este e-mail — sua senha atual permanece a mesma.")}`,
        ),
        text: `Redefinir sua senha

Olá, {{{FIRST_NAME|tudo bem}}} — abra este link para escolher uma nova senha:
{{{RESET_URL|https://example.com/reset}}}

O link expira em 30 minutos. Se não foi você, ignore este e-mail.`,
      },
    },
  },

  "otp-code": {
    category: "authentication",
    copies: {
      en: {
        name: "Verification code (OTP)",
        description: "Big one-time code block for logins and 2FA.",
        subject: "Your verification code",
        html: shell(
          "en",
          "Your one-time verification code is inside.",
          `${heading("Your verification code")}
${para("Enter this code to continue. It's valid for the next 10 minutes.")}
${codeBlock("{{{CODE|123456}}}")}
${muted("Never share this code — nobody from our team will ask for it.")}`,
        ),
        text: `Your verification code: {{{CODE|123456}}}

It's valid for the next 10 minutes. Never share this code.`,
      },
      "pt-BR": {
        name: "Código de verificação (OTP)",
        description: "Bloco grande de código único para login e 2FA.",
        subject: "Seu código de verificação",
        html: shell(
          "pt-BR",
          "Seu código de verificação está aqui dentro.",
          `${heading("Seu código de verificação")}
${para("Digite este código para continuar. Ele vale pelos próximos 10 minutos.")}
${codeBlock("{{{CODE|123456}}}")}
${muted("Nunca compartilhe este código — ninguém do nosso time vai pedir ele.")}`,
        ),
        text: `Seu código de verificação: {{{CODE|123456}}}

Ele vale pelos próximos 10 minutos. Nunca compartilhe este código.`,
      },
    },
  },

  "order-confirmation": {
    category: "commerce",
    copies: {
      en: {
        name: "Order confirmation",
        description: "Itemized order summary with totals and a view-order CTA.",
        subject: "Order {{{ORDER_ID|#1024}}} confirmed",
        html: shell(
          "en",
          "Your order is confirmed. Here's the summary.",
          `${heading("Order {{{ORDER_ID|#1024}}} confirmed")}
${para("Thanks, {{{FIRST_NAME|there}}}! We're preparing your order now.")}
${itemsTable([["Product A — 1x", "{{{ORDER_TOTAL|$49.00}}}"]])}
${button("{{{ORDER_URL|https://example.com/orders/1024}}}", "View order")}
${muted("You'll get another email as soon as it ships.")}`,
        ),
        text: `Order {{{ORDER_ID|#1024}}} confirmed

Thanks, {{{FIRST_NAME|there}}}! We're preparing your order now.

Total: {{{ORDER_TOTAL|$49.00}}}

View order: {{{ORDER_URL|https://example.com/orders/1024}}}`,
      },
      "pt-BR": {
        name: "Confirmação de pedido",
        description: "Resumo do pedido com itens, total e CTA para ver o pedido.",
        subject: "Pedido {{{ORDER_ID|#1024}}} confirmado",
        html: shell(
          "pt-BR",
          "Seu pedido foi confirmado. Veja o resumo.",
          `${heading("Pedido {{{ORDER_ID|#1024}}} confirmado")}
${para("Obrigado, {{{FIRST_NAME|tudo bem}}}! Já estamos preparando seu pedido.")}
${itemsTable([["Produto A — 1x", "{{{ORDER_TOTAL|R$ 249,00}}}"]])}
${button("{{{ORDER_URL|https://example.com/pedidos/1024}}}", "Ver pedido")}
${muted("Você recebe outro e-mail assim que ele for enviado.")}`,
        ),
        text: `Pedido {{{ORDER_ID|#1024}}} confirmado

Obrigado, {{{FIRST_NAME|tudo bem}}}! Já estamos preparando seu pedido.

Total: {{{ORDER_TOTAL|R$ 249,00}}}

Ver pedido: {{{ORDER_URL|https://example.com/pedidos/1024}}}`,
      },
    },
  },

  "shipping-update": {
    category: "commerce",
    copies: {
      en: {
        name: "Shipping update",
        description: "Order on the way, with tracking code and CTA.",
        subject: "Your order is on the way",
        html: shell(
          "en",
          "Your order shipped. Track it any time.",
          `${heading("Your order is on the way")}
${para("Good news, {{{FIRST_NAME|there}}} — order {{{ORDER_ID|#1024}}} just shipped.")}
${itemsTable([["Tracking code", "{{{TRACKING_CODE|BR123456789}}}"]])}
${button("{{{TRACKING_URL|https://example.com/track}}}", "Track package")}
${muted("Delivery estimates depend on the carrier and your region.")}`,
        ),
        text: `Your order is on the way

Good news, {{{FIRST_NAME|there}}} — order {{{ORDER_ID|#1024}}} just shipped.

Tracking code: {{{TRACKING_CODE|BR123456789}}}
Track package: {{{TRACKING_URL|https://example.com/track}}}`,
      },
      "pt-BR": {
        name: "Atualização de envio",
        description: "Pedido a caminho, com código de rastreio e CTA.",
        subject: "Seu pedido está a caminho",
        html: shell(
          "pt-BR",
          "Seu pedido foi enviado. Acompanhe quando quiser.",
          `${heading("Seu pedido está a caminho")}
${para("Boa notícia, {{{FIRST_NAME|tudo bem}}} — o pedido {{{ORDER_ID|#1024}}} acabou de ser enviado.")}
${itemsTable([["Código de rastreio", "{{{TRACKING_CODE|BR123456789}}}"]])}
${button("{{{TRACKING_URL|https://example.com/rastreio}}}", "Rastrear pedido")}
${muted("Os prazos de entrega dependem da transportadora e da sua região.")}`,
        ),
        text: `Seu pedido está a caminho

Boa notícia, {{{FIRST_NAME|tudo bem}}} — o pedido {{{ORDER_ID|#1024}}} acabou de ser enviado.

Código de rastreio: {{{TRACKING_CODE|BR123456789}}}
Rastrear pedido: {{{TRACKING_URL|https://example.com/rastreio}}}`,
      },
    },
  },

  "cart-abandonment": {
    category: "commerce",
    copies: {
      en: {
        name: "Abandoned cart",
        description: "Reminder with the product left behind and a finish-checkout CTA.",
        subject: "You left something behind",
        html: shell(
          "en",
          "Still thinking it over? Your cart is saved.",
          `${heading("You left something behind")}
${para("Hi {{{FIRST_NAME|there}}} — your cart is still saved, and items can sell out.")}
${itemsTable([["{{{PRODUCT_NAME|Product A}}} — 1x", "{{{ORDER_TOTAL|$49.00}}}"]])}
${button("{{{CHECKOUT_URL|https://example.com/checkout}}}", "Finish checkout")}
${muted("If you've already completed your order, ignore this email.")}`,
        ),
        text: `You left something behind

Hi {{{FIRST_NAME|there}}} — your cart is still saved.

{{{PRODUCT_NAME|Product A}}} — {{{ORDER_TOTAL|$49.00}}}
Finish checkout: {{{CHECKOUT_URL|https://example.com/checkout}}}`,
      },
      "pt-BR": {
        name: "Carrinho abandonado",
        description: "Lembrete com o produto esquecido e CTA para finalizar.",
        subject: "Você deixou algo no carrinho",
        html: shell(
          "pt-BR",
          "Ainda pensando? Seu carrinho está salvo.",
          `${heading("Você deixou algo no carrinho")}
${para("Olá, {{{FIRST_NAME|tudo bem}}} — seu carrinho continua salvo, e os itens podem esgotar.")}
${itemsTable([["{{{PRODUCT_NAME|Produto A}}} — 1x", "{{{ORDER_TOTAL|R$ 249,00}}}"]])}
${button("{{{CHECKOUT_URL|https://example.com/finalizar}}}", "Finalizar compra")}
${muted("Se você já concluiu seu pedido, ignore este e-mail.")}`,
        ),
        text: `Você deixou algo no carrinho

Olá, {{{FIRST_NAME|tudo bem}}} — seu carrinho continua salvo.

{{{PRODUCT_NAME|Produto A}}} — {{{ORDER_TOTAL|R$ 249,00}}}
Finalizar compra: {{{CHECKOUT_URL|https://example.com/finalizar}}}`,
      },
    },
  },

  receipt: {
    category: "commerce",
    copies: {
      en: {
        name: "Payment receipt",
        description: "Payment confirmation with amount, method and invoice CTA.",
        subject: "Your receipt — {{{ORDER_ID|#1024}}}",
        html: shell(
          "en",
          "Payment received. Your receipt is inside.",
          `${heading("Payment received")}
${para("Thanks, {{{FIRST_NAME|there}}}! We've received your payment.")}
${itemsTable([
  ["Reference", "{{{ORDER_ID|#1024}}}"],
  ["Amount", "{{{ORDER_TOTAL|$49.00}}}"],
  ["Method", "Visa •••• 4242"],
])}
${button("{{{INVOICE_URL|https://example.com/invoices/1024}}}", "View invoice")}
${muted("Keep this email for your records.")}`,
        ),
        text: `Payment received — {{{ORDER_ID|#1024}}}

Amount: {{{ORDER_TOTAL|$49.00}}}
Method: Visa •••• 4242

View invoice: {{{INVOICE_URL|https://example.com/invoices/1024}}}`,
      },
      "pt-BR": {
        name: "Recibo de pagamento",
        description: "Confirmação de pagamento com valor, forma e CTA da nota.",
        subject: "Seu recibo — {{{ORDER_ID|#1024}}}",
        html: shell(
          "pt-BR",
          "Pagamento recebido. Seu recibo está aqui.",
          `${heading("Pagamento recebido")}
${para("Obrigado, {{{FIRST_NAME|tudo bem}}}! Recebemos seu pagamento.")}
${itemsTable([
  ["Referência", "{{{ORDER_ID|#1024}}}"],
  ["Valor", "{{{ORDER_TOTAL|R$ 249,00}}}"],
  ["Forma", "Visa •••• 4242"],
])}
${button("{{{INVOICE_URL|https://example.com/notas/1024}}}", "Ver nota fiscal")}
${muted("Guarde este e-mail para seus registros.")}`,
        ),
        text: `Pagamento recebido — {{{ORDER_ID|#1024}}}

Valor: {{{ORDER_TOTAL|R$ 249,00}}}
Forma: Visa •••• 4242

Ver nota fiscal: {{{INVOICE_URL|https://example.com/notas/1024}}}`,
      },
    },
  },

  newsletter: {
    category: "marketing",
    copies: {
      en: {
        name: "Newsletter",
        description: "Broadcast base with sections and unsubscribe footer.",
        subject: "{{{NEWSLETTER_TITLE|This week's update}}}",
        html: shell(
          "en",
          "A short update, made for skimming.",
          `${heading("{{{NEWSLETTER_TITLE|This week's update}}}")}
${para("Hi {{{FIRST_NAME|there}}} — here's what's new:")}
${para("<strong>What shipped.</strong> One or two sentences about the most important update.")}
${para("<strong>Worth a look.</strong> A useful link, a tip, or an answer to a frequent question.")}
${button("{{{CTA_URL|https://example.com/blog}}}", "Read more")}
`,
          `You're receiving this because you subscribed to updates. <a href="{{{UNSUBSCRIBE_URL}}}" style="color:#71717a;">Unsubscribe</a> at any time.`,
        ),
        text: `{{{NEWSLETTER_TITLE|This week's update}}}

Hi {{{FIRST_NAME|there}}} — here's what's new:

What shipped. One or two sentences about the most important update.
Worth a look. A useful link, a tip, or an answer to a frequent question.

Read more: {{{CTA_URL|https://example.com/blog}}}

Unsubscribe: {{{UNSUBSCRIBE_URL}}}`,
      },
      "pt-BR": {
        name: "Newsletter",
        description: "Base de transmissão com seções e rodapé de descadastro.",
        subject: "{{{NEWSLETTER_TITLE|Novidades da semana}}}",
        html: shell(
          "pt-BR",
          "Uma atualização curta, feita para ler rápido.",
          `${heading("{{{NEWSLETTER_TITLE|Novidades da semana}}}")}
${para("Olá, {{{FIRST_NAME|tudo bem}}} — veja o que há de novo:")}
${para("<strong>O que saiu.</strong> Uma ou duas frases sobre a novidade mais importante.")}
${para("<strong>Vale a pena ver.</strong> Um link útil, uma dica ou resposta a uma dúvida frequente.")}
${button("{{{CTA_URL|https://example.com/blog}}}", "Ler mais")}
`,
          `Você recebe isto porque assinou nossas atualizações. <a href="{{{UNSUBSCRIBE_URL}}}" style="color:#71717a;">Descadastrar</a> a qualquer momento.`,
        ),
        text: `{{{NEWSLETTER_TITLE|Novidades da semana}}}

Olá, {{{FIRST_NAME|tudo bem}}} — veja o que há de novo:

O que saiu. Uma ou duas frases sobre a novidade mais importante.
Vale a pena ver. Um link útil, uma dica ou resposta a uma dúvida frequente.

Ler mais: {{{CTA_URL|https://example.com/blog}}}

Descadastrar: {{{UNSUBSCRIBE_URL}}}`,
      },
    },
  },

  winback: {
    category: "marketing",
    copies: {
      en: {
        name: "Win-back offer",
        description: "Re-engagement with a discount code and a return CTA.",
        subject: "We miss you — here's {{{DISCOUNT_CODE|WELCOME10}}}",
        html: shell(
          "en",
          "A small gift to bring you back.",
          `${heading("We miss you, {{{FIRST_NAME|friend}}}")}
${para("It's been a while — and to make your return easier, here's a code for your next order:")}
${codeBlock("{{{DISCOUNT_CODE|WELCOME10}}}")}
${button("{{{CTA_URL|https://example.com/shop}}}", "Come back")}
`,
          `You're receiving this because you shopped with us before. <a href="{{{UNSUBSCRIBE_URL}}}" style="color:#71717a;">Unsubscribe</a> at any time.`,
        ),
        text: `We miss you, {{{FIRST_NAME|friend}}}

Here's a code for your next order: {{{DISCOUNT_CODE|WELCOME10}}}
Come back: {{{CTA_URL|https://example.com/shop}}}

Unsubscribe: {{{UNSUBSCRIBE_URL}}}`,
      },
      "pt-BR": {
        name: "Recuperação (win-back)",
        description: "Reengajamento com cupom de desconto e CTA de retorno.",
        subject: "Sentimos sua falta — cupom {{{DISCOUNT_CODE|VOLTEI10}}}",
        html: shell(
          "pt-BR",
          "Um pequeno presente para você voltar.",
          `${heading("Sentimos sua falta, {{{FIRST_NAME|tudo bem}}}!")}
${para("Faz um tempinho — e para facilitar sua volta, aqui vai um cupom para o próximo pedido:")}
${codeBlock("{{{DISCOUNT_CODE|VOLTEI10}}}")}
${button("{{{CTA_URL|https://example.com/loja}}}", "Voltar agora")}
`,
          `Você recebe isto porque já comprou com a gente. <a href="{{{UNSUBSCRIBE_URL}}}" style="color:#71717a;">Descadastrar</a> a qualquer momento.`,
        ),
        text: `Sentimos sua falta, {{{FIRST_NAME|tudo bem}}}!

Aqui vai um cupom para o próximo pedido: {{{DISCOUNT_CODE|VOLTEI10}}}
Voltar agora: {{{CTA_URL|https://example.com/loja}}}

Descadastrar: {{{UNSUBSCRIBE_URL}}}`,
      },
    },
  },
};

function normalizeLocale(locale: AppLocale | string | undefined): "en" | "pt-BR" {
  return locale === "pt-BR" ? "pt-BR" : "en";
}

/** Metadata for every starter, localized, in the canonical STARTER_KEYS order. */
export function listStarters(locale: AppLocale | string | undefined): StarterMeta[] {
  const lc = normalizeLocale(locale);
  return STARTER_KEYS.map((key) => {
    const s = STARTERS[key];
    const copy = s.copies[lc];
    return { key, category: s.category, name: copy.name, description: copy.description };
  });
}

/** Full renderable content of one starter (metadata + subject + html + text). */
export function renderStarter(
  key: StarterKey,
  locale: AppLocale | string | undefined,
): StarterDetail {
  const lc = normalizeLocale(locale);
  const s = STARTERS[key];
  const copy = s.copies[lc];
  return {
    key,
    category: s.category,
    name: copy.name,
    description: copy.description,
    subject: copy.subject,
    html: copy.html,
    text: copy.text,
  };
}

/** One list with the renderable payload included — feeds the picker grid. */
export function listStartersWithContent(locale: AppLocale | string | undefined): StarterDetail[] {
  return STARTER_KEYS.map((key) => renderStarter(key, locale));
}

export function isStarterKey(value: string): value is StarterKey {
  return (STARTER_KEYS as readonly string[]).includes(value);
}
