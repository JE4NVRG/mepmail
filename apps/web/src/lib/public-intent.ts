/**
 * What a visitor came for, carried from the public pages into the account: the paid plan they
 * picked, the product their campaign was about, and whether they are inside an app's own
 * browser. No React, so server pages and client leaves share it.
 */
import { PLAN_RUNGS, type PlanRungKey } from "@millionsend/core/plans";
import { isMailboxPlanCode, type MailboxPlanCode } from "./mailbox-plans";

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;

/** A paid Send plan by its key; anything else (free, unknown, a list) is no intent. */
export function paidRung(value: unknown): PlanRungKey | null {
  if (typeof value !== "string") return null;
  return PLAN_RUNGS.find((rung) => rung.key === value && rung.priceCents > 0)?.key ?? null;
}

/**
 * Where a public "Start" button goes. A paid plan's button signs up and then opens Billing on
 * that plan (the comparison only: every purchase still takes a click there); the free one, and
 * anything unknown, is the plain sign-up, which ends in the onboarding.
 */
export function signupHref(rung?: string | null): string {
  const paid = paidRung(rung);
  return paid ? `/signup?next=${encodeURIComponent(`/settings/billing?plan=${paid}`)}` : "/signup";
}

export type MailboxPurchaseIntent = { plan: MailboxPlanCode | null };

/** Only opens the Correio plan selector; prices and purchase eligibility stay server-owned. */
export function mailboxPurchasePath(plan?: MailboxPlanCode | null): string {
  return `/mail?setup=correio${isMailboxPlanCode(plan) ? `&plan=${plan}` : ""}`;
}

export function signupMailboxHref(plan?: MailboxPlanCode | null): string {
  return `/signup?next=${encodeURIComponent(mailboxPurchasePath(plan))}`;
}

/** Plain /mail is also the free external-account flow and must never open a purchase. */
export function requestedMailboxPurchase(params: SearchParams): MailboxPurchaseIntent | null {
  if (single(params.setup) !== "correio") return null;
  const plan = single(params.plan);
  return { plan: isMailboxPlanCode(plan) ? plan : null };
}

/** The plan a Billing link asks for (?plan=pro_100k), or none. */
export function requestedPlan(params: SearchParams): PlanRungKey | null {
  return paidRung(single(params.plan));
}

/**
 * /pricing opens on Send for a Send campaign: ?focus=send, or a utm_campaign that names send
 * (mepmail_send_us_20261013). Everything else keeps the page's own order.
 */
export function pricingFocus(params: SearchParams): "send" | null {
  if (single(params.focus) === "send") return "send";
  const campaign = single(params.utm_campaign);
  return campaign && /(?:^|[_-])send(?:[_-]|$)/i.test(campaign) ? "send" : null;
}

/**
 * An app's built-in browser (Facebook, Instagram, TikTok, LinkedIn, X, Line, Snapchat). It
 * keeps its own cookies, so a confirmation link opens in the phone's browser and asks to sign in
 * again there, and Google refuses its sign-in inside Android's embedded browsers.
 */
export function inAppBrowser(userAgent: string): "android" | "ios" | null {
  if (
    !/FBAN|FBAV|FB_IAB|FBIOS|Instagram|BytedanceWebview|musical_ly|TikTok|LinkedInApp|Twitter|Line\/|Snapchat/i.test(
      userAgent,
    )
  )
    return null;
  if (/Android/i.test(userAgent)) return "android";
  return /iPhone|iPad|iPod/i.test(userAgent) ? "ios" : null;
}

/** Android opens the same page in Chrome through an intent; the page stays as the fallback. */
export function openInBrowserHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
}
