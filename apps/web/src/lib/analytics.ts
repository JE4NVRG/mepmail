import { cookieValue } from "./attribution";
import {
  clickContext,
  FUNNEL_INTENT_COOKIE,
  funnelClickProps,
  normalizeFunnelPlan,
} from "./funnel-tracking";

// Umami self-hosted (JE4NDEV) — analytics do site público.
//
// Os dois valores abaixo são PÚBLICOS: eles aparecem no HTML de toda página
// pública de qualquer forma, então ficam em código (e não em env de build) —
// o build via Docker não recebe NEXT_PUBLIC_* do runtime.
export const UMAMI_SCRIPT_URL = "https://umami.je4ndev.com/script.js";

// Website "mepmail-web" (domínio mepmail.je4ndev.com) na instância própria.
export const UMAMI_WEBSITE_ID = "167a3266-4a56-4fd1-8d14-59ed7437a313";

type UmamiTracker = {
  track: (event: string, data?: Record<string, unknown>) => void | Promise<unknown>;
};

// O tracker vive em uma origem externa e pode não estar carregado (bloqueador,
// offline, script ainda baixando). Medição é best-effort: nunca pode quebrar
// a navegação do usuário — daí o optional chaining.
export function trackEvent(event: string, data?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    if (event === "signup_start") {
      let intent: { product?: string; plan?: string; selection_state?: string } = {};
      try {
        const raw = cookieValue(document.cookie, FUNNEL_INTENT_COOKIE);
        const parsed = raw ? JSON.parse(decodeURIComponent(raw)) : null;
        if (parsed?.version === 1 && (parsed.product === "send" || parsed.product === "mail"))
          intent = parsed;
      } catch {
        /* Untrusted metadata is optional, never an auth/billing input. */
      }
      const explicit = data?.product === "send" || data?.product === "mail";
      const location = new URL(window.location.href);
      const requestedHere =
        location.pathname === "/signup" &&
        ["product", "plan", "next", "selection_state"].some((key) =>
          location.searchParams.has(key),
        );
      const context = clickContext({
        href: requestedHere ? location.href : "/signup",
        search: window.location.search,
        cookie: document.cookie,
        ...(explicit ? { product: data?.product as string } : requestedHere ? {} : intent),
        ...(typeof data?.plan === "string" ? { plan: data.plan } : {}),
        ...(typeof data?.selection_state === "string"
          ? { selection_state: data.selection_state }
          : {}),
      });
      data = { ...data };
      delete data.plan;
      delete data.plan_label;
      delete data.selection_state;
      data = { ...data, ...funnelClickProps(context) };
      if (context.utm_source) data.source = context.utm_source;
      else delete data.source;
    }
    if (event === "plan_card_view" || event === "cta_pricing_click") {
      // Card metadata must never borrow a different product's last-click cookie.
      const product =
        data?.product === "mail"
          ? "mail"
          : data?.product === "send"
            ? "send"
            : normalizeFunnelPlan("mail", data?.plan).plan
              ? "mail"
              : "send";
      const selection =
        data?.plan === undefined &&
        (data?.selection_state === "unknown" || data?.selection_state === "unselected")
          ? { selection_state: data.selection_state }
          : normalizeFunnelPlan(product, data?.plan);
      data = { ...data, product };
      delete data.plan;
      delete data.plan_label;
      delete data.selection_state;
      data = { ...data, ...selection };
    }
    const tracker = (window as unknown as { umami?: UmamiTracker }).umami;
    const result = tracker?.track(event, data);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {
    // A blocked/throwing collector must never block a real navigation.
  }
}
