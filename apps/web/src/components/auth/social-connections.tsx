"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import type { SocialProviderFlags } from "./auth-form";
import { GitHubIcon, GoogleIcon, MicrosoftIcon } from "./social-icons";

type Provider = keyof SocialProviderFlags;
const PROVIDERS = ["github", "google", "microsoft"] as const;
const LABELS = { github: "GitHub", google: "Google", microsoft: "Microsoft" };
const ICONS = { github: GitHubIcon, google: GoogleIcon, microsoft: MicrosoftIcon };

/** Login identities belong to the signed-in user, independently of MCP grants. */
export function SocialConnections({ providers }: { providers: SocialProviderFlags }) {
  const t = useTranslations("auth.connections");
  const params = useSearchParams();
  const { data: session } = authClient.useSession();
  const enabled = PROVIDERS.filter((provider) => providers[provider]);
  const [pending, setPending] = useState<Provider | null>(null);
  const [failed, setFailed] = useState(false);
  const accounts = useQuery({
    queryKey: ["login-identities", session?.user.id],
    enabled: Boolean(session?.user.id) && enabled.length > 0,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error("Could not read login identities");
      // Only provider names enter the UI cache; account identifiers/tokens are not needed.
      return (data ?? []).map((account) => account.providerId);
    },
  });

  const refetchAccounts = accounts.refetch;
  useEffect(() => {
    const resume = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // Going Back from the provider can restore a document still marked pending.
      setPending(null);
      setFailed(false);
      void refetchAccounts();
    };
    window.addEventListener("pageshow", resume);
    return () => window.removeEventListener("pageshow", resume);
  }, [refetchAccounts]);

  if (enabled.length === 0) return null;
  const linked = accounts.data ?? [];
  const busy = pending !== null || accounts.isPending || accounts.isError;
  const callbackFailed = params.get("linkSocial") === "error";
  const callbackProvider = params.get("linkedSocial");
  const confirmed = enabled.some(
    (provider) => callbackProvider === provider && linked.includes(provider),
  );

  async function link(provider: Provider) {
    if (busy || linked.includes(provider)) return;
    setFailed(false);
    setPending(provider);
    try {
      const { error } = await authClient.linkSocial({
        provider,
        callbackURL: `/settings?linkedSocial=${provider}#account-connections`,
        errorCallbackURL: "/settings?linkSocial=error#account-connections",
      });
      if (error) {
        setFailed(true);
        setPending(null);
      }
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <section id="account-connections" className="ms-card" style={{ padding: 24, marginBottom: 24 }}>
      <h2 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: "0 0 12px" }}>
        {t("title")}
      </h2>
      <p style={{ color: "var(--ms-muted)", margin: "0 0 18px", maxWidth: 680 }}>
        {t("description")}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {enabled.map((provider) => {
          const Icon = ICONS[provider];
          const connected = linked.includes(provider);
          return (
            <button
              key={provider}
              type="button"
              className="ms-btn ms-btn-secondary"
              disabled={busy || connected}
              onClick={() => void link(provider)}
            >
              <Icon />
              <BtnSpinner on={pending === provider} />
              {t(connected ? "connected" : "connect", { provider: LABELS[provider] })}
            </button>
          );
        })}
      </div>
      <p style={{ color: "var(--ms-muted)", margin: "14px 0 0", maxWidth: 680 }}>
        {t("sameEmail")}
      </p>
      {accounts.isError ? (
        <p role="alert" style={{ margin: "14px 0 0" }}>
          {t("readError")}{" "}
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => void accounts.refetch()}
          >
            {t("retry")}
          </button>
        </p>
      ) : null}
      {failed || callbackFailed ? (
        <p role="alert" style={{ margin: "14px 0 0" }}>
          {t("linkError")}
        </p>
      ) : null}
      {confirmed ? (
        <p role="status" style={{ margin: "14px 0 0" }}>
          {t("success")}
        </p>
      ) : null}
    </section>
  );
}
