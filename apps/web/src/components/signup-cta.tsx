"use client";

import { trackEvent } from "@/lib/analytics";

// CTA de criação de conta. Dispara o evento de conversão `signup-cta` no Umami
// no clique e deixa a navegação seguir normalmente para /signup — o handler é
// síncrono e não chama preventDefault, então o clique nunca depende da medição.
export function SignupCta({ label, className }: { label: string; className?: string }) {
  return (
    <a className={className} href="/signup" onClick={() => trackEvent("signup-cta")}>
      {label}
    </a>
  );
}
