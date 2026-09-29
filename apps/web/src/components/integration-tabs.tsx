"use client";

import { type ReactNode, useId, useRef, useState } from "react";

export interface IntegrationTab {
  label: string;
  content: ReactNode;
}

export function IntegrationTabs({ label, tabs }: { label: string; tabs: IntegrationTab[] }) {
  const id = useId();
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="cro-integration-tabs">
      <div role="tablist" aria-label={label} className="cro-tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel-${index}`}
            aria-selected={active === index}
            tabIndex={active === index ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setActive(next);
              buttons.current[next]?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.label}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: painel ARIA com conteúdo estático deve receber foco após a tab
          tabIndex={0}
          hidden={active !== index}
          className="cro-tabpanel"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
