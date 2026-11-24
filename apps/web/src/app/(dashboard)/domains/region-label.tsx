"use client";

import { useTranslations } from "next-intl";
import { regionFlag, regionName } from "./regions";

export function RegionFlagSvg({ region }: { region: string }) {
  const wrapStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 3,
    overflow: "hidden",
    border: "1px solid var(--ms-line-strong)",
    flexShrink: 0,
  };
  switch (region) {
    case "us-east-1":
      return (
        <span style={wrapStyle} aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
            <rect width="18" height="12" fill="#b22234" />
            <path d="M0 2h18M0 5h18M0 8h18M0 11h18" stroke="#f4f1ea" strokeWidth="1" />
            <rect width="8" height="6.5" fill="#3c3b6e" />
          </svg>
        </span>
      );
    case "eu-west-1":
      return (
        <span style={wrapStyle} aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
            <rect width="6" height="12" x="0" fill="#169b62" />
            <rect width="6" height="12" x="6" fill="#f4f1ea" />
            <rect width="6" height="12" x="12" fill="#ff883e" />
          </svg>
        </span>
      );
    case "sa-east-1":
      return (
        <span style={wrapStyle} aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
            <rect width="18" height="12" fill="#009c3b" />
            <polygon points="9,1.5 16,6 9,10.5 2,6" fill="#ffdf00" />
            <circle cx="9" cy="6" r="2.4" fill="#002776" />
          </svg>
        </span>
      );
    case "ap-northeast-1":
      return (
        <span style={wrapStyle} aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
            <rect width="18" height="12" fill="#f4f1ea" />
            <circle cx="9" cy="6" r="3.2" fill="#bc002d" />
          </svg>
        </span>
      );
    default: {
      const code = regionFlag(region);
      return code ? (
        <span className="ms-badge ms-badge-neutral ms-mono" style={{ fontSize: 10.5 }}>
          {code}
        </span>
      ) : null;
    }
  }
}

/**
 * Flag + localized city + region code.
 * `list` renders the code subtle in parens; `meta` renders it mono muted.
 */
export function RegionLabel({
  region,
  variant = "list",
}: {
  region: string;
  variant?: "list" | "meta";
}) {
  const t = useTranslations("domains");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <RegionFlagSvg region={region} />
      <span>{regionName(region, t)}</span>
      {variant === "list" ? (
        <span className="ms-mono" style={{ fontSize: 11.5, color: "var(--ms-muted)" }}>
          {region}
        </span>
      ) : (
        <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
          {region}
        </span>
      )}
    </span>
  );
}
