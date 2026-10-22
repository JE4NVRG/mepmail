"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { Skeleton } from "@/components/skeleton";
import { useTRPC } from "@/lib/trpc";

type Tone = "danger" | "warn";

const TONE_COLOR: Record<Tone | "ok", string> = {
  danger: "var(--ms-danger, #f87171)",
  warn: "var(--ms-warn, #fbbf24)",
  ok: "var(--ms-success, #34d399)",
};

function Dot({ tone }: { tone: Tone | "ok" }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        flex: "none",
        background: TONE_COLOR[tone],
        boxShadow: `0 0 0 3px color-mix(in srgb, ${TONE_COLOR[tone]} 18%, transparent)`,
      }}
    />
  );
}

/**
 * "Needs you": the console's first answer. Only teams that still send count;
 * suspended ones are already decided. Every row links to where it is fixed.
 */
export function AttentionCard() {
  const t = useTranslations("console.overview.attention");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const trpc = useTRPC();
  const query = useQuery(trpc.console.overview.attention.queryOptions());
  const a = query.data;

  if (query.isError) return null;
  if (!a) {
    return (
      <div style={{ marginBottom: 16 }}>
        <Skeleton width="100%" height={132} radius="var(--ms-r-card)" />
      </div>
    );
  }

  const rows: { key: string; tone: Tone; count: number; href: string }[] = [
    {
      key: "requests",
      tone: "danger" as const,
      count: a.requests,
      href: "/console/safety#signup-reviews",
    },
    { key: "held", tone: "danger" as const, count: a.held, href: "/console/safety#signup-reviews" },
    {
      key: "guardrailPaused",
      tone: "danger" as const,
      count: a.guardrailPaused,
      href: "/console/teams?status=active&guardrail=paused",
    },
    { key: "flags", tone: "warn" as const, count: a.flags, href: "/console/safety" },
    {
      key: "sandboxed",
      tone: "warn" as const,
      count: a.sandboxed,
      href: "/console/safety#signup-reviews",
    },
    {
      key: "guardrailWarning",
      tone: "warn" as const,
      count: a.guardrailWarning,
      href: "/console/teams?status=active&guardrail=warning",
    },
  ].filter((row) => row.count > 0);
  const domains = a.failedDomains;
  const urgent = rows.filter((row) => row.tone === "danger").length;
  const clear = rows.length === 0 && domains.total === 0;

  return (
    <section
      className="ms-card"
      aria-labelledby="console-attention-title"
      style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 20px",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid var(--ms-line)",
        }}
      >
        <h2 id="console-attention-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {t("title")}
          {rows.length + (domains.total ? 1 : 0) > 0 ? (
            <span
              className={`ms-badge ${urgent ? "ms-badge-danger" : "ms-badge-warn"}`}
              style={{ marginLeft: 10, verticalAlign: "middle" }}
            >
              {t("pending", { count: rows.length + (domains.total ? 1 : 0) })}
            </span>
          ) : null}
        </h2>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13 }}>
          <Link href="/console/teams?status=active" style={{ textDecoration: "none" }}>
            <strong className="ms-digits" style={{ color: "var(--ms-bone)" }}>
              {nf.format(a.teams.active)}
            </strong>{" "}
            <span style={{ color: "var(--ms-muted)" }}>{t("active")}</span>
          </Link>
          <span>
            <strong className="ms-digits" style={{ color: "var(--ms-bone)" }}>
              {nf.format(a.teams.newActive7d)}
            </strong>{" "}
            <span style={{ color: "var(--ms-muted)" }}>{t("newWeek")}</span>
          </span>
          <Link href="/console/teams?status=suspended" style={{ textDecoration: "none" }}>
            <strong className="ms-digits" style={{ color: "var(--ms-muted)" }}>
              {nf.format(a.teams.suspended)}
            </strong>{" "}
            <span style={{ color: "var(--ms-muted)" }}>
              {t("suspended", { week: nf.format(a.teams.newSuspended7d) })}
            </span>
          </Link>
        </div>
      </header>

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {clear ? (
          <li style={{ display: "flex", gap: 12, alignItems: "center", padding: "14px 20px" }}>
            <Dot tone="ok" />
            <span style={{ color: "var(--ms-bone)" }}>{t("clear")}</span>
            <span style={{ color: "var(--ms-muted)", fontSize: 13 }}>{t("clearSub")}</span>
          </li>
        ) : null}
        {rows.map((row) => (
          <li key={row.key} style={{ borderTop: "1px solid var(--ms-line)" }}>
            <Link
              href={row.href}
              className="ms-attn-row"
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                padding: "12px 20px",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <Dot tone={row.tone} />
              <strong className="ms-digits" style={{ minWidth: 28 }}>
                {nf.format(row.count)}
              </strong>
              <span style={{ flex: 1 }}>{t(`rows.${row.key}`)}</span>
              <span style={{ color: "var(--ms-muted)", fontSize: 13 }}>{t("open")} →</span>
            </Link>
          </li>
        ))}
        {domains.total > 0 ? (
          <li
            style={{
              display: "flex",
              gap: 12,
              alignItems: "center",
              flexWrap: "wrap",
              padding: "12px 20px",
              borderTop: rows.length || clear ? "1px solid var(--ms-line)" : undefined,
            }}
          >
            <Dot tone="warn" />
            <strong className="ms-digits" style={{ minWidth: 28 }}>
              {nf.format(domains.total)}
            </strong>
            <span>{t("rows.failedDomains")}</span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
              {domains.items.map((d) => (
                <Link
                  key={d.id}
                  href={`/console/teams?status=active&q=${encodeURIComponent(d.team)}`}
                  className="ms-chip"
                  title={d.team}
                  style={{ textDecoration: "none", fontSize: 12 }}
                >
                  {d.name}
                </Link>
              ))}
              {domains.total > domains.items.length ? (
                <span style={{ color: "var(--ms-muted)", fontSize: 12, alignSelf: "center" }}>
                  {t("more", { count: domains.total - domains.items.length })}
                </span>
              ) : null}
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
