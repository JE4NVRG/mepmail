"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { statusCodeTone } from "@/lib/status-code-color";
import { useTRPC } from "@/lib/trpc";

export interface DiagnosisErrorFilter {
  path: string;
  statusClass: "4xx" | "5xx";
}

/**
 * The first question a new integration asks is "is my key even reaching you?".
 * This answers it above the raw log: whether anything arrived, whether a send
 * ever succeeded, and which error repeats. Values come from the same
 * api_requests rows, so the card cannot disagree with the list below it.
 */
export function DiagnosisCard({
  onSelectError,
  activeFilter,
}: {
  onSelectError?: (filter: DiagnosisErrorFilter) => void;
  activeFilter?: { path: string; statusClass: string };
}) {
  const t = useTranslations("logs.diagnosis");
  const trpc = useTRPC();
  const diagnosis = useQuery(trpc.logs.diagnosis.queryOptions());

  if (diagnosis.isPending || !diagnosis.data) return null;
  const d = diagnosis.data;

  const steps = new Map(d.onboarding.map((row) => [row.step, row.at]));
  const hasDomain = steps.has("domain_verified");
  const hasKey = d.requests > 0;
  const sent = d.firstSendAt != null;

  // The three questions, answered in the order a person hits them.
  const rows = [
    { key: "reach", done: hasKey, at: d.firstAt },
    { key: "domain", done: hasDomain, at: steps.get("domain_verified") ?? null },
    { key: "send", done: sent, at: d.firstSendAt },
  ] as const;

  const next = rows.find((row) => !row.done);
  const allDone = !next;
  const successCount = Math.max(0, d.requests - d.failures);
  const successPct = d.requests > 0 ? Math.round((successCount / d.requests) * 100) : 100;

  return (
    <section className="ms-card" aria-label={t("title")} style={{ padding: 16, marginBottom: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>{t("title")}</h2>
          {allDone ? <span className="ms-badge ms-badge-success">{t("readyBadge")}</span> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
            {t("counts", { requests: d.requests, failures: d.failures })}
          </span>
          {d.requests > 0 ? (
            <span
              className={`ms-badge ms-badge-${successPct >= 95 ? "success" : successPct >= 80 ? "warn" : "danger"} ms-mono`}
            >
              {t("successRate", { rate: successPct })}
            </span>
          ) : null}
        </div>
      </div>

      {d.requests > 0 ? (
        <div
          aria-hidden="true"
          style={{
            marginTop: 10,
            height: 3,
            borderRadius: 99,
            background: d.failures > 0 ? "var(--ms-warn-bg)" : "var(--ms-line)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${successPct}%`,
              height: "100%",
              background:
                successPct >= 95
                  ? "var(--ms-success)"
                  : successPct >= 80
                    ? "var(--ms-warn)"
                    : "var(--ms-danger)",
              transition: "width var(--ms-dur-base) var(--ms-ease)",
            }}
          />
        </div>
      ) : null}

      {allDone ? (
        <ol
          style={{
            listStyle: "none",
            padding: 0,
            margin: "10px 0 0",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 16px",
          }}
        >
          {rows.map((row) => (
            <li
              key={row.key}
              title={
                row.at
                  ? `${new Date(row.at).toISOString().slice(0, 16).replace("T", " ")}Z`
                  : undefined
              }
              style={{
                display: "inline-flex",
                gap: 6,
                alignItems: "center",
                fontSize: 12.5,
                color: "var(--ms-muted)",
              }}
            >
              <span aria-hidden style={{ color: "var(--ms-success)" }}>
                ✓
              </span>
              <span>{t(`step.${row.key}`)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <>
          <ol
            style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}
          >
            {rows.map((row) => (
              <li key={row.key} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span
                  aria-hidden
                  style={{ color: row.done ? "var(--ms-bone)" : "var(--ms-faint)" }}
                >
                  {row.done ? "✓" : "○"}
                </span>
                <span
                  style={{ fontSize: 13, color: row.done ? "var(--ms-bone)" : "var(--ms-muted)" }}
                >
                  {t(`step.${row.key}`)}
                </span>
                {row.at ? (
                  <span className="ms-mono" style={{ fontSize: 11, color: "var(--ms-faint)" }}>
                    {new Date(row.at).toISOString().slice(0, 16).replace("T", " ")}Z
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {next.key === "reach"
              ? t("next.reach")
              : next.key === "domain"
                ? t("next.domain")
                : t("next.send")}{" "}
            <Link href={next.key === "domain" ? "/domains" : "/api-keys"}>{t("next.link")}</Link>
          </p>
        </>
      )}

      {d.errors.length > 0 ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid var(--ms-line)",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--ms-muted)", marginBottom: 6 }}>
            {t("errorsTitle")}
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr)",
              gap: 4,
            }}
          >
            {d.errors.map((error) => {
              const statusClass = error.statusCode >= 500 ? "5xx" : "4xx";
              const isSelected =
                activeFilter?.path === error.path && activeFilter?.statusClass === statusClass;
              const content = (
                <>
                  <span className={`ms-badge ms-badge-${statusCodeTone(error.statusCode)} ms-mono`}>
                    {error.statusCode}
                  </span>
                  <span style={{ flexShrink: 0, color: "var(--ms-bone)" }}>{error.path}</span>
                  <span className="ms-badge ms-badge-neutral ms-mono" style={{ flexShrink: 0 }}>
                    ×{error.count}
                  </span>
                  {error.message ? (
                    <span
                      title={error.message}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        paddingRight: 4,
                        color: "var(--ms-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {error.message}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li
                  key={`${error.path}-${error.statusCode}-${error.message ?? ""}`}
                  style={{ minWidth: 0, overflow: "hidden" }}
                >
                  {onSelectError ? (
                    <button
                      type="button"
                      className="ms-mono"
                      title={t("filterByError")}
                      aria-pressed={isSelected}
                      onClick={() => onSelectError({ path: error.path, statusClass })}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        padding: "5px 8px",
                        borderRadius: 8,
                        border: `1px solid ${isSelected ? "var(--ms-bone)" : "transparent"}`,
                        background: isSelected ? "var(--ms-panel-raised)" : "transparent",
                        cursor: "pointer",
                        transition:
                          "background var(--ms-dur-fast) var(--ms-ease), border-color var(--ms-dur-fast) var(--ms-ease)",
                      }}
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      className="ms-mono"
                      style={{
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        padding: "3px 0",
                      }}
                    >
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
