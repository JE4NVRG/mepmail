"use client";

import { useEffect, useRef, useState } from "react";
import { DOCS_URL } from "@/lib/docs-links";
import {
  createEloziSupportSession,
  type EloziSupportConfig,
  type EloziSupportStatus,
} from "@/lib/elozi-support";

export type EloziSupportLabels = {
  eyebrow: string;
  title: string;
  body: string;
  available: string;
  pending: string;
  open: string;
  reopen: string;
  loading: string;
  opened: string;
  error: string;
  privacy: string;
  email: string;
  docs: string;
};

export function EloziSupport({
  config,
  labels,
}: {
  config: EloziSupportConfig | null;
  labels: EloziSupportLabels;
}) {
  const [status, setStatus] = useState<EloziSupportStatus | null>(null);
  const session = useRef<ReturnType<typeof createEloziSupportSession> | null>(null);
  useEffect(() => {
    if (!config) return;
    const current = createEloziSupportSession(config, setStatus);
    session.current = current;
    return () => {
      current.destroy();
      session.current = null;
    };
  }, [config]);

  return (
    <aside className="gtm-support-assistance" aria-labelledby="support-assistance-title">
      <p className="gtm-eyebrow">{labels.eyebrow}</p>
      <h2 id="support-assistance-title">{labels.title}</h2>
      <p>{labels.body}</p>
      <div className="gtm-support-state">
        <span className="gtm-support-dot" aria-hidden="true" />
        {config ? labels.available : labels.pending}
      </div>
      {config && (
        <button
          type="button"
          className="ms-btn ms-btn-primary gtm-action"
          disabled={status === "loading"}
          onClick={() => void session.current?.open()}
        >
          {status === "loading"
            ? labels.loading
            : status === "opened"
              ? labels.reopen
              : labels.open}
        </button>
      )}
      <p className="gtm-note gtm-support-feedback" role="status" aria-live="polite">
        {status ? labels[status] : ""}
      </p>
      <p className="gtm-note">{labels.privacy}</p>
      <div className="gtm-support-alternatives">
        <a href="mailto:support@je4ndev.com">{labels.email}</a>
        <a href={DOCS_URL}>{labels.docs}</a>
      </div>
    </aside>
  );
}
