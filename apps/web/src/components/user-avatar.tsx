"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

/** Uses the account's own photo; no email hash is sent to an avatar service. */
export function UserAvatar({ email, size = 28 }: { email?: string; size?: number }) {
  const { data: session } = authClient.useSession();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const user = session?.user;
  const source = user && (!email || user.email === email) ? user.image : null;
  const safeSource =
    source &&
    (source.startsWith("https://") || (source.startsWith("/") && !source.startsWith("//")))
      ? source
      : null;
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderRadius: "50%",
        background: "var(--ms-panel-raised)",
        border: "1px solid var(--ms-line)",
        fontSize: Math.max(11, size / 3),
      }}
    >
      {safeSource && failedSource !== safeSource ? (
        // biome-ignore lint/performance/noImgElement: provider/bucket URL is rendered directly, without forwarding it to an image proxy
        <img
          src={safeSource}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={() => setFailedSource(safeSource)}
        />
      ) : (
        (user?.name || email || "?").charAt(0).toUpperCase()
      )}
    </span>
  );
}
