"use client";

import { initials } from "@/lib/avatar";

/**
 * Contact identity mark: a deterministic circular letter mark (initials from
 * the name, else the email). Avoids speculative third-party Gravatar fetches
 * that leak hashed addresses and spam 404 errors in console/network logs.
 */
export function ContactAvatar({
  email,
  name,
  size,
}: {
  email: string;
  name?: string | null | undefined;
  size: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "1px solid var(--ms-line)",
        background: "var(--ms-panel-raised)",
        color: "var(--ms-muted)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        flex: "none",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {initials(name?.trim() ? name : email)}
    </span>
  );
}
