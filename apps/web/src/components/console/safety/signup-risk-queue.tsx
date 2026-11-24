"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Table } from "@/components/table";
import { useTRPC } from "@/lib/trpc";

const SCOPES = ["pending", "suspended", "all"] as const;

export function SignupRiskQueue() {
  const t = useTranslations("console.signupRisk");
  const trpc = useTRPC();
  const [offset, setOffset] = useState(0);
  // Suspended teams are already decided: the default tab is what still needs one.
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("pending");
  const query = useQuery(
    trpc.console.safety.signupReviews.queryOptions({ offset, limit: 25, scope }),
  );
  const counts = query.data?.counts;
  return (
    <section id="signup-reviews" className="ms-card" style={{ padding: 20, marginBottom: 20 }}>
      <h2
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 4px" }}
      >
        {t("queue.title")}
      </h2>
      <p style={{ color: "var(--ms-muted)", fontSize: "var(--ms-fs-label)", margin: "0 0 14px" }}>
        {t("queue.subtitle")}
      </p>
      <div
        className="ms-tabs"
        role="tablist"
        aria-label={t("queue.scope.label")}
        style={{ marginBottom: 14 }}
      >
        {SCOPES.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={scope === key}
            className={scope === key ? "active" : undefined}
            onClick={() => {
              setScope(key);
              setOffset(0);
            }}
          >
            {key === "all"
              ? t("queue.scope.all")
              : t(`queue.scope.${key}`, { count: counts ? counts[key] : "…" })}
          </button>
        ))}
      </div>
      {query.isError ? (
        <p role="alert">
          {t("failed")}{" "}
          <button
            className="ms-btn ms-btn-secondary"
            type="button"
            onClick={() => void query.refetch()}
          >
            {t("retry")}
          </button>
        </p>
      ) : query.isPending ? (
        <p role="status">{t("queue.loading")}</p>
      ) : (
        <>
          <Table className="nowrap">
            <thead>
              <tr>
                <th>{t("queue.team")}</th>
                <th>{t("queue.level")}</th>
                <th>{t("queue.effective")}</th>
                <th>{t("queue.reasons")}</th>
                <th>{t("queue.payment")}</th>
                <th>{t("queue.since")}</th>
              </tr>
            </thead>
            <tbody>
              {(query.data?.items ?? []).map((row) => (
                <tr key={row.teamId}>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Link href={`/console/safety/${row.teamId}`}>{row.name}</Link>
                      {row.reviewRequestedAt ? (
                        <span className="ms-badge ms-badge-warn">{t("queue.requested")}</span>
                      ) : null}
                    </span>
                  </td>
                  <td>{row.level ? t(`levels.${row.level}`) : t("legacy")}</td>
                  <td>{t(`effectiveLevels.${row.restriction}`)}</td>
                  <td style={{ whiteSpace: "normal", overflowWrap: "anywhere", minWidth: 180 }}>
                    {row.reasons.length ? row.reasons.join(", ") : t("queue.noReasons")}
                  </td>
                  <td>{t(row.paid ? "queue.paid" : "queue.unconfirmed")}</td>
                  <td style={{ color: "var(--ms-muted)" }}>
                    {row.since ? <RelativeTime date={row.since} /> : "—"}
                  </td>
                </tr>
              ))}
              {!query.data?.items?.length ? (
                <tr>
                  <td colSpan={6} style={{ color: "var(--ms-muted)" }}>
                    {scope === "pending" ? t("queue.scope.emptyPending") : t("queue.empty")}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </Table>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: "var(--ms-fs-label)", color: "var(--ms-muted)" }}>
              {t("queue.count", { count: query.data?.total ?? 0 })}
            </span>
            {offset > 0 || query.data?.nextOffset != null ? (
              <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                <button
                  className="ms-btn ms-btn-secondary"
                  type="button"
                  disabled={offset === 0 || query.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  {t("queue.previous")}
                </button>
                <button
                  className="ms-btn ms-btn-secondary"
                  type="button"
                  disabled={query.data?.nextOffset == null || query.isFetching}
                  onClick={() => setOffset(query.data?.nextOffset ?? offset)}
                >
                  {t("queue.next")}
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
