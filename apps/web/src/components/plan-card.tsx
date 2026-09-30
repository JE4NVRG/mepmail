"use client";

import { useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics";
import type { LandingPlan, PlanCopy } from "@/lib/landing-plans";
import { SignupCta } from "./signup-cta";

/**
 * The plan card shared by the landing's #planos section and /pricing. The labels
 * come from the "landing" catalog (plans.*) and the copy from plans.items, so a
 * copy change lands on both pages at once.
 *
 * Client-side for two of the launch plan's events (launch-ops.md §3.2): the card
 * reports `plan_card_view` once, when it actually enters the viewport, and its
 * CTA reports `cta_pricing_click` with the plan — the server-rendered pages stay
 * server components and only this leaf animates the measurement.
 */
export interface PlanCardLabels {
  perMonth: string;
  limitsLabel: string;
  overageLabel: string;
  attachmentLabel: string;
  cta: string;
  ctaNote: string;
  featuredBadge: string;
}

export function PlanCard({ plan, labels }: { plan: LandingPlan; labels: PlanCardLabels }) {
  const copy: PlanCopy = plan.copy;
  const card = useRef<HTMLElement | null>(null);
  // One view per card per page load: scrolling away and back is not a new view,
  // and the Scale cards fire only once the <details> fold is opened.
  const seen = useRef(false);

  useEffect(() => {
    const node = card.current;
    if (!node || seen.current) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || seen.current) continue;
          seen.current = true;
          trackEvent("plan_card_view", { plan: plan.name });
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [plan.name]);

  return (
    <article ref={card} className={`ms-card gtm-plan${plan.featured ? " is-featured" : ""}`}>
      {plan.featured ? <span className="gtm-plan-badge">{labels.featuredBadge}</span> : null}
      <h3>{plan.name}</h3>
      <p className="gtm-price">
        {plan.price}
        <span>{labels.perMonth}</span>
      </p>
      <p className="gtm-volume">{copy.volume}</p>
      <dl>
        <div>
          <dt>{labels.limitsLabel}</dt>
          <dd>{copy.limits}</dd>
        </div>
        <div>
          <dt>{labels.overageLabel}</dt>
          <dd>{copy.overage}</dd>
        </div>
        <div>
          <dt>{labels.attachmentLabel}</dt>
          <dd>{copy.attachment}</dd>
        </div>
      </dl>
      <SignupCta
        className="ms-btn ms-btn-primary gtm-action"
        label={copy.cta ?? labels.cta}
        plan={plan.name}
        rung={plan.rung}
      />
      {plan.price !== "US$ 0" ? <p className="gtm-cta-note">{labels.ctaNote}</p> : null}
    </article>
  );
}
