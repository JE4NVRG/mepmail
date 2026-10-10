"use client";

import { useEffect, useState } from "react";
import {
  createEloziSupportSession,
  type EloziSupportConfig,
  type EloziSupportStatus,
  fetchEloziIdentityToken,
} from "@/lib/elozi-support";

export type SupportChatWindowLabels = {
  title: string;
  body: string;
  loading: string;
  error: string;
  email: string;
};

/** The chat alone, opened at once; verified when the person is signed in. */
export function SupportChatWindow({
  config,
  identified,
  labels,
}: {
  config: EloziSupportConfig | null;
  identified: boolean;
  labels: SupportChatWindowLabels;
}) {
  const [status, setStatus] = useState<EloziSupportStatus | null>(config ? "loading" : "error");
  useEffect(() => {
    if (!config) return;
    const session = createEloziSupportSession(
      config,
      setStatus,
      undefined,
      identified ? () => fetchEloziIdentityToken() : undefined,
    );
    void session.open();
    return () => session.destroy();
  }, [config, identified]);
  return (
    <main className="support-chat-window">
      <h1>{labels.title}</h1>
      <p>{labels.body}</p>
      <p className="support-chat-status" role="status" aria-live="polite">
        {status === "loading" ? labels.loading : status === "error" ? labels.error : ""}
      </p>
      <a href="mailto:suporte@mepmail.dev">{labels.email}</a>
    </main>
  );
}
