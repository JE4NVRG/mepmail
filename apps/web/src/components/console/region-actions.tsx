"use client";

import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { AppRouter } from "@/server/routers";

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** One served region as console.regions.list returns it. */
export type ServedRegion = RouterOutputs["console"]["regions"]["list"]["served"][number];

/**
 * CONTRACT for the Regions screen owner: the "…" menu of a served region
 * (refresh probe, request quota increase, production access template,
 * pause/resume broadcasts in this region, stop serving) with its dialogs.
 * Rendered in the Overview's region cards and the Regions table rows.
 * `onChanged` re-fetches the caller's list after an action.
 */
export function RegionMenu({ region, onChanged }: { region: ServedRegion; onChanged: () => void }) {
  void region;
  void onChanged;
  return null;
}

/**
 * CONTRACT for the Regions screen owner: the Overview's region card (flag,
 * city, code, Serving/Sandbox badge, 24h quota bar, key/value rows, the
 * bleed sparkline of sends per hour, the RegionMenu).
 */
export function RegionCard({ region, onChanged }: { region: ServedRegion; onChanged: () => void }) {
  void region;
  void onChanged;
  return null;
}

/** The dashed "Add a region" card; the Regions page opens its panel for `?add=<region>`. */
export function AddRegionCard({ region }: { region: string }) {
  const t = useTranslations("console.overview.addRegion");
  return (
    <div
      className="ms-card"
      style={{
        borderStyle: "dashed",
        boxShadow: "none",
        background: "transparent",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textAlign: "center",
        color: "var(--ms-muted)",
        minHeight: 220,
        padding: 24,
      }}
    >
      <div style={{ fontSize: 18, letterSpacing: 4, filter: "grayscale(1)", opacity: 0.7 }}>
        🇮🇪 🇯🇵 🇩🇪
      </div>
      <div style={{ fontWeight: 600, color: "var(--ms-bone)" }}>{t("title")}</div>
      <div style={{ fontSize: 13, maxWidth: 230 }}>{t("body")}</div>
      <Link
        href={`/console/regions?add=${encodeURIComponent(region)}`}
        className="ms-btn ms-btn-secondary"
      >
        {t("cta", { region })}
      </Link>
    </div>
  );
}
