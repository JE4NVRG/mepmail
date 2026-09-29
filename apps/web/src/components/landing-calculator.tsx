"use client";

import { useLocale } from "next-intl";
import { useId, useMemo, useState } from "react";
import { trackEvent } from "@/lib/analytics";
import { formatUsd, formatVolume, PRICE_ROWS } from "@/lib/landing-pricing";
import { savingsForIndex } from "@/lib/landing-savings";

export interface CalcLabels {
  title: string;
  lead: string;
  volumeLabel: string;
  ours: string;
  /** "Concorrente mais barato ({name})" */
  cheapest: string;
  /** "Economia de {percent}% (~{usd}/mês)" */
  savings: string;
  /** "≈ {usd} por ano" */
  annual: string;
  cta: string;
  /** "Calculadora MepMail — {volume} e-mails/mês" */
  ctaSubject: string;
  note: string;
  a11y: string;
  /** mailto: URL of the commercial contact. */
  contact: string;
}

/**
 * Interactive savings estimate: slide to a published volume, see the MepMail
 * price, the cheapest public competitor and the yearly difference. Numbers come
 * from @/lib/landing-pricing — the same data the comparison table renders — and
 * render in the reader's locale (US separators in en, Brazilian ones in pt-BR).
 */
export function LandingCalculator({ labels }: { labels: CalcLabels }) {
  const [index, setIndex] = useState(2); // default: 550K, the middle rung
  const locale = useLocale();
  const id = useId();
  const savings = useMemo(() => savingsForIndex(index), [index]);
  const volume = formatVolume(savings.row.volume, locale);
  const savingsText = labels.savings
    .replace("{percent}", String(savings.savingsPct))
    .replace("{usd}", formatUsd(savings.savingsUsd, locale));
  const mailto = `${labels.contact}?subject=${encodeURIComponent(
    labels.ctaSubject.replace("{volume}", volume),
  )}`;

  return (
    <div className="gtm-calc">
      <h3>{labels.title}</h3>
      <p className="gtm-note">{labels.lead}</p>
      <label htmlFor={id}>
        {labels.volumeLabel}: <strong>{volume}</strong>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={PRICE_ROWS.length - 1}
        step={1}
        value={index}
        aria-label={labels.a11y}
        onChange={(event) => {
          const next = Number(event.target.value);
          setIndex(next);
          const row = PRICE_ROWS[next];
          if (row)
            trackEvent("pricing_slider_change", { volume: formatVolume(row.volume, locale) });
        }}
      />
      <div className="gtm-calc-result" aria-live="polite">
        <p className="gtm-calc-line">
          <span>{labels.ours}</span>
          <strong>{formatUsd(savings.row.mepmail, locale)}</strong>
        </p>
        <p className="gtm-calc-line">
          <span>{labels.cheapest.replace("{name}", savings.competitor.name)}</span>
          <strong>{formatUsd(savings.competitor.price, locale)}</strong>
        </p>
        <p className="gtm-calc-savings">{savingsText}</p>
        <p className="gtm-note">
          {labels.annual.replace("{usd}", formatUsd(savings.savingsYearUsd, locale))}
        </p>
      </div>
      <a className="ms-btn ms-btn-primary gtm-action" href={mailto}>
        {labels.cta}
      </a>
      <p className="gtm-note">{labels.note}</p>
    </div>
  );
}
