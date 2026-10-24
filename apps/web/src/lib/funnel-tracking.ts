import { cookieValue, parseAttributionCookie } from "./attribution";
import { PLANS } from "./landing-plans";
import { MAILBOX_PLAN_NAMES } from "./mailbox-plans";

export type FunnelProduct = "send" | "mail";
export const FUNNEL_INTENT_COOKIE = "mm_funnel_intent";
const KEYS = ["source", "medium", "campaign", "content", "term"] as const;
export type FunnelClickContext = {
  product: FunnelProduct;
  plan?: string;
  plan_label?: string;
  selection_state?: "unselected" | "unknown";
} & Partial<Record<`utm_${(typeof KEYS)[number]}`, string>>;

/** Metadata only. Neither the URL nor this cookie authorizes a plan or a payment. */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip untrusted campaign controls.
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, "");
  const s = stripped.trim().slice(0, 120);
  if (!s || /@|(?:sk|rk)_(?:live|test)_|whsec_|(?:mmb|mmt)_|^eyJ/i.test(s)) return undefined;
  return s;
}
/** Public catalog aliases only: display volume is not a billing code. */
export function normalizeFunnelPlan(
  product: FunnelProduct,
  value: unknown,
): Pick<FunnelClickContext, "plan" | "plan_label" | "selection_state"> {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!key || key === "choose") return { selection_state: "unselected" };
  const catalog =
    product === "send"
      ? PLANS.map((p) => ({ code: p.rung, name: p.name }))
      : Object.entries(MAILBOX_PLAN_NAMES).map(([code, name]) => ({ code, name }));
  const match = catalog.find(
    (p) => p.code === key || p.name.toLowerCase().replace(/\s/g, "") === key.replace(/\s/g, ""),
  );
  return match ? { plan: match.code, plan_label: match.name } : { selection_state: "unknown" };
}

export function clickContext(input: {
  href: string;
  search?: string;
  cookie?: string;
  origin?: string;
  product?: string;
  plan?: string;
  selection_state?: string;
}): FunnelClickContext {
  const origin = input.origin ?? "https://mepmail.dev";
  const url = new URL(input.href, origin);
  const params = new URLSearchParams(input.search ?? "");
  let next: URL | null = null;
  try {
    const raw = url.searchParams.get("next");
    if (raw?.startsWith("/") && !raw.startsWith("//")) next = new URL(raw, origin);
  } catch {
    // Invalid redirect metadata is ignored; the existing auth gate owns navigation.
  }
  const urlProduct = url.searchParams.get("product");
  const product =
    input.product === "mail" || input.product === "send"
      ? input.product
      : urlProduct === "mail" || urlProduct === "send"
        ? urlProduct
        : next?.pathname === "/mail"
          ? "mail"
          : "send";
  const requested = input.plan ?? url.searchParams.get("plan") ?? next?.searchParams.get("plan");
  const state = input.selection_state ?? url.searchParams.get("selection_state");
  const selection: Pick<FunnelClickContext, "plan" | "plan_label" | "selection_state"> =
    requested === undefined || requested === null
      ? state === "unknown" || state === "unselected"
        ? { selection_state: state }
        : normalizeFunnelPlan(product, product === "mail" ? "choose" : "free")
      : normalizeFunnelPlan(product, requested);
  const result: FunnelClickContext = { product, ...selection };
  const visit = parseAttributionCookie(cookieValue(input.cookie ?? null, "mm_attr"));
  for (const key of KEYS) {
    const name = `utm_${key}` as const;
    // Explicit incoming campaign wins, as it does in the proxy's attribution rule.
    const values = params.getAll(name);
    const value = label(values.length === 1 ? values[0] : undefined) ?? label(visit?.[key]);
    if (value) result[name] = value;
  }
  return result;
}

/** Adds only measured metadata; keeps locale, next and every existing destination gate. */
export function trackedSignupHref(
  href: string,
  context: FunnelClickContext,
  origin = "https://mepmail.dev",
): string {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return href;
  }
  if (url.origin !== origin || url.pathname !== "/signup") return href;
  url.searchParams.set("product", context.product);
  if (context.plan) url.searchParams.set("plan", context.plan);
  else url.searchParams.delete("plan");
  if (context.selection_state) url.searchParams.set("selection_state", context.selection_state);
  else url.searchParams.delete("selection_state");
  for (const key of KEYS) {
    const name = `utm_${key}` as const;
    const value = label(context[name]);
    if (value) url.searchParams.set(name, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function funnelClickProps(context: FunnelClickContext): Record<string, string> {
  return { ...context, measurement_version: "2" };
}
export function intentCookie(context: FunnelClickContext, secure: boolean): string {
  const value = encodeURIComponent(
    JSON.stringify({
      version: 1,
      product: context.product,
      plan: context.plan,
      selection_state: context.selection_state,
    }),
  );
  return `${FUNNEL_INTENT_COOKIE}=${value}; Path=/; Max-Age=7776000; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function publicFunnelPath(path: string): boolean {
  return (
    [
      "/",
      "/pricing",
      "/signup",
      "/login",
      "/correio",
      "/envio",
      "/delivery",
      "/security",
      "/terms",
      "/privacy",
      "/integrations",
      "/download",
      "/guides",
    ].includes(path) ||
    path.startsWith("/alternatives/") ||
    path.startsWith("/guides/")
  );
}
