"use client";

import { usePathname } from "next/navigation";
import { trackEvent } from "@/lib/analytics";
import { clickContext, funnelClickProps } from "@/lib/funnel-tracking";
import type { MailboxPlanCode } from "@/lib/mailbox-plans";
import { visitSource } from "@/lib/public-funnel";
import { signupHref, signupMailboxHref } from "@/lib/public-intent";

/**
 * CTA de criação de conta. Dispara `signup_start` no Umami no clique e deixa a
 * navegação seguir normalmente para /signup — o handler é síncrono e não chama
 * preventDefault, então o clique nunca depende da medição.
 *
 * `signup_start` leva a `source` do cookie de atribuição que o proxy gravou na
 * primeira visita (o mesmo valor que o servidor lê para atribuir a conta), e a
 * `page` de onde o clique saiu. Sem cookie não há `source`: a prop é omitida em
 * vez de reportar "direct" para um canal que não foi medido.
 *
 * O CTA de um card de plano é o mesmo caminho de entrada em /signup, então ele
 * também emite `signup_start` e, com `plan`, o `cta_pricing_click` que o plano
 * de lançamento pede por card. Com `rung` pago, o cadastro termina na Cobrança
 * com esse plano aberto (lib/public-intent.ts): a escolha não se perde.
 */
export function SignupCta({
  label,
  className,
  plan,
  rung,
  mailboxPlan,
}: {
  label: string;
  className?: string;
  plan?: string;
  rung?: string;
  /** "choose" preserves the Correio product without preselecting a paid plan. */
  mailboxPlan?: MailboxPlanCode | "choose";
}) {
  const pathname = usePathname();
  const href = mailboxPlan
    ? signupMailboxHref(mailboxPlan === "choose" ? null : mailboxPlan)
    : signupHref(rung);
  function onClick() {
    const context = clickContext({
      href,
      search: window.location.search,
      cookie: document.cookie,
      product: mailboxPlan ? "mail" : "send",
      plan: mailboxPlan ?? rung ?? "free",
    });
    const source = visitSource(document.cookie);
    trackEvent("signup_start", {
      ...funnelClickProps(context),
      page: pathname,
      ...(source ? { source } : {}),
    });
    if (plan) trackEvent("cta_pricing_click", { ...funnelClickProps(context) });
  }
  return (
    <a
      data-funnel-signup="1"
      data-funnel-product={mailboxPlan ? "mail" : "send"}
      data-funnel-plan={mailboxPlan ?? rung ?? "free"}
      className={className}
      href={href}
      onClick={onClick}
    >
      {label}
    </a>
  );
}
