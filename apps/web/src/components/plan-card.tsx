import type { LandingPlan, PlanCopy } from "@/lib/landing-plans";
import { SignupLink } from "./site-chrome";

/**
 * The plan card shared by the landing's #planos section and /pricing. The labels
 * come from the "landing" catalog (plans.*) and the copy from plans.items, so a
 * copy change lands on both pages at once.
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
  return (
    <article className={`ms-card gtm-plan${plan.featured ? " is-featured" : ""}`}>
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
      <SignupLink label={copy.cta ?? labels.cta} />
      {plan.price !== "US$ 0" ? <p className="gtm-cta-note">{labels.ctaNote}</p> : null}
    </article>
  );
}
