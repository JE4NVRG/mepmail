"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { sendingClarityMessage } from "@/lib/sending-clarity";

/** Keep API history separate from the native mailbox outbox. */
export function ApiSendsScope() {
  const t = useTranslations("common");
  return (
    <div style={{ marginBottom: 20, overflowWrap: "anywhere" }}>
      <p style={{ color: "var(--ms-muted)", margin: "0 0 8px" }}>
        {sendingClarityMessage(t, "apiSends.description")}
      </p>
      <Link href="/mail" className="ms-btn ms-btn-secondary">
        {sendingClarityMessage(t, "apiSends.mailLink")}
      </Link>
    </div>
  );
}
