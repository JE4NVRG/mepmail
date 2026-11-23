"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTRPC } from "@/lib/trpc";

/**
 * The first question a new integration asks is "is my key even reaching you?".
 * This answers it above the raw log: whether anything arrived, whether a send
 * ever succeeded, and which error repeats. Values come from the same
 * api_requests rows, so the card cannot disagree with the list below it.
 */
export function DiagnosisCard() {
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

  return (
    <section className="ms-card" aria-label={t("title")} style={{ padding: 16, marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{t("title")}</h2>
        <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
          {t("counts", { requests: d.requests, failures: d.failures })}
        </span>
      </div>

      <ol style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
        {rows.map((row) => (
          <li key={row.key} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span aria-hidden style={{ color: row.done ? "var(--ms-bone)" : "var(--ms-faint)" }}>
              {row.done ? "✓" : "○"}
            </span>
            <span style={{ fontSize: 13, color: row.done ? "var(--ms-bone)" : "var(--ms-muted)" }}>
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

      {next ? (
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          {next.key === "reach"
            ? t("next.reach")
            : next.key === "domain"
              ? t("next.domain")
              : t("next.send")}{" "}
          <Link href={next.key === "domain" ? "/domains" : "/api-keys"}>{t("next.link")}</Link>
        </p>
      ) : null}

      {d.errors.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--ms-muted)", marginBottom: 6 }}>
            {t("errorsTitle")}
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 4 }}>
            {d.errors.map((error) => (
              <li
                key={`${error.path}-${error.statusCode}-${error.message ?? ""}`}
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", display: "flex", gap: 8 }}
              >
                <span style={{ color: "var(--ms-faint)" }}>{error.statusCode}</span>
                <span>{error.path}</span>
                <span style={{ color: "var(--ms-faint)" }}>×{error.count}</span>
                {error.message ? <span>{error.message.slice(0, 90)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
