"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-setup-dialog.module.css";

/** Where each DNS host keeps its record editor (the account's own dashboard). */
const PROVIDER_DASHBOARD: Record<string, string | undefined> = {
  cloudflare: "https://dash.cloudflare.com/",
  registrobr: "https://registro.br/painel/",
  godaddy: "https://dcc.godaddy.com/domains",
  route53: "https://console.aws.amazon.com/route53/v2/hostedzones",
  hostinger: "https://hpanel.hostinger.com/domains",
  locaweb: "https://painel.locaweb.com.br/",
};

/**
 * The receiving (MX) assistant shown while a domain still needs its MX: the
 * DNS host we detected, the one record to add with copy buttons, steps for
 * that host, and a warning when the domain already receives mail elsewhere.
 */
export function MailboxDnsGuidePanel({
  domainId,
  checking,
  onRecheck,
}: {
  domainId: string;
  checking: boolean;
  onRecheck: () => void;
}) {
  const t = useTranslations("mailboxes.dnsGuide");
  const trpc = useTRPC();
  const id = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const guide = useQuery(
    trpc.mailboxes.receivingGuide.queryOptions({ domainId }, { retry: false, staleTime: 30_000 }),
  );
  const data = guide.data;
  if (!data) return null;
  // Route 53 takes the priority inside the value; everyone else has a field for it.
  const value = data.provider === "route53" ? `10 ${data.mx.exchange}` : data.mx.exchange;
  const foreign = data.current.filter((record) => !record.ours);
  const hosts = foreign.map((record) => record.exchange).join(", ");
  const dashboard = PROVIDER_DASHBOARD[data.provider];
  const values = {
    zone: data.zone,
    domain: data.domain,
    name: data.recordName,
    value,
    nameservers: data.nameservers.join(", ") || "?",
  };

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  const field = (key: string, label: string, text: string, copyable = true) => (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{text}</code>
        {copyable ? (
          <button
            type="button"
            className={styles.copy}
            onClick={() => void copy(key, text)}
            aria-label={t("copyLabel", { field: label })}
          >
            {copied === key ? t("copied") : t("copy")}
          </button>
        ) : null}
      </dd>
    </div>
  );

  return (
    <section className={styles.dnsGuide} aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t("title")}</h4>
      <p>{t(`provider.${data.provider}`, values)}</p>
      {foreign.length ? (
        <p className={styles.dnsWarning}>
          {data.otherProvider
            ? t("currentKnown", { ...values, provider: data.otherProvider, hosts })
            : t("currentOther", { ...values, hosts })}
        </p>
      ) : null}
      <dl className={styles.dnsRecord}>
        {field("type", t("type"), "MX", false)}
        {field("name", t("name"), data.recordName)}
        {field("value", t("value"), value)}
        {data.provider === "route53" ? null : field("priority", t("priority"), "10", false)}
      </dl>
      {data.recordName === "@" ? <p className={styles.hint}>{t("apexHint")}</p> : null}
      <ol className={styles.dnsSteps}>
        {(["1", "2", "3"] as const).map((step) => (
          <li key={step}>{t(`steps.${data.provider}.${step}`, values)}</li>
        ))}
        {foreign.length ? <li>{t("removeOld", { hosts })}</li> : null}
      </ol>
      <div className={styles.successActions}>
        {dashboard ? (
          <a className="ms-btn" href={dashboard} target="_blank" rel="noreferrer">
            {t("openProvider", { provider: t(`providerName.${data.provider}`) })}
          </a>
        ) : null}
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={checking || guide.isFetching}
          onClick={() => {
            void guide.refetch();
            onRecheck();
          }}
        >
          {t(checking || guide.isFetching ? "checking" : "checkNow")}
        </button>
      </div>
      <p className={styles.hint}>{t("propagation")}</p>
    </section>
  );
}
