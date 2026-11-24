"use client";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { useId, useState } from "react";
import { reputationSnapshot } from "@/lib/reputation-adapter";
import { useTRPC } from "@/lib/trpc";
import en from "../../messages/en/reputation.json";
import pt from "../../messages/pt-BR/reputation.json";
import { ReputationPanel } from "./reputation-panel";
export function TeamReputation() {
  const locale = useLocale();
  const t = locale === "pt-BR" ? pt : en;
  const trpc = useTRPC();
  const id = useId();
  const [domainId, setDomainId] = useState<string | null>(null);
  const domains = useQuery({ ...trpc.domains.list.queryOptions(), retry: false });
  const selected = domains.data?.find((domain) => domain.id === domainId);
  const validScope = domainId === null || !!selected;
  const query = useQuery({
    ...trpc.reputation.get.queryOptions({ domainId }),
    retry: false,
    enabled: domains.isSuccess && validScope,
    placeholderData: () => undefined,
  });
  const error = domains.isError ? domains.error : query.isError ? query.error : null;
  const status = error
    ? error.data?.code === "FORBIDDEN" || error.data?.code === "UNAUTHORIZED"
      ? "forbidden"
      : "error"
    : !validScope && domains.isSuccess
      ? "unavailable"
      : domains.isPending || query.isPending
        ? "loading"
        : !query.data
          ? "unavailable"
          : "ready";
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="ms-field" style={{ marginBottom: 6 }}>
        <label htmlFor={id}>{t.domainSelector}</label>
        <select
          id={id}
          className="ms-input"
          value={domainId ?? ""}
          disabled={!domains.isSuccess}
          aria-describedby={`${id}-scope`}
          style={{
            display: "block",
            width: "min(100%, 580px)",
            height: 36,
            paddingRight: 32,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            cursor: "pointer",
          }}
          onChange={(event) => setDomainId(event.target.value || null)}
        >
          <option value="">{t.principalScope}</option>
          {domains.data?.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name} · {domain.status === "verified" ? t.domainVerified : t.domainPending}
            </option>
          ))}
        </select>
      </div>
      <p
        id={`${id}-scope`}
        role="status"
        style={{
          margin: "0 0 12px",
          fontSize: 12,
          color: "var(--ms-muted)",
          overflowWrap: "anywhere",
        }}
      >
        {domainId === null
          ? t.principalExplanation
          : selected
            ? `${t.domainScope}: ${selected.name} · ${selected.status === "verified" ? t.domainVerified : t.domainPending}`
            : t.unavailable}
      </p>
      {status === "ready" && query.data ? (
        <ReputationPanel locale={locale} status="ready" snapshot={reputationSnapshot(query.data)} />
      ) : (
        <ReputationPanel locale={locale} status={status === "ready" ? "unavailable" : status} />
      )}
    </div>
  );
}
