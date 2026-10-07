"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { formatUsd } from "@/lib/format";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { useTRPC } from "@/lib/trpc";

/** Correio for teams that cannot use it yet: presentation only, every purchase stays server-gated. */
export function MailboxOffer() {
  const t = useTranslations("mailboxes.offer");
  const locale = useLocale();
  const trpc = useTRPC();
  const teams = useQuery(trpc.team.list.queryOptions());
  const role = teams.data?.teams.find((m) => m.teamId === teams.data.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";
  const [small, large] = LAUNCH_OFFER.mailboxes;
  const usd = (cents: number) => formatUsd(cents, locale);
  const points = [
    t("points.addresses"),
    t("points.agents"),
    t("points.price", {
      small: `${small.storageGiB} GiB`,
      smallPrice: usd(small.monthlyCents),
      large: `${large.storageGiB} GiB`,
      largePrice: usd(large.monthlyCents),
    }),
  ];
  return (
    <section
      className="ms-card"
      style={{ padding: 28, maxWidth: 760 }}
      aria-labelledby="mail-offer"
    >
      <div className="ms-microlabel" style={{ marginBottom: 10 }}>
        {t("eyebrow")}
      </div>
      <h1
        id="mail-offer"
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", margin: "0 0 12px" }}
      >
        {t("title")}
      </h1>
      <p style={{ margin: "0 0 18px", color: "var(--ms-muted)", fontSize: 15, lineHeight: 1.6 }}>
        {t("body")}
      </p>
      <ul className="ms-checklist" style={{ margin: "0 0 18px" }}>
        {points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <p style={{ margin: "0 0 22px", color: "var(--ms-muted)", fontSize: 13.5, lineHeight: 1.6 }}>
        {t("requirement", {
          price: usd(LAUNCH_OFFER.sending.monthlyCents),
          first: usd(LAUNCH_OFFER.sending.firstMonthlyCents),
        })}
      </p>
      <div className="ms-wrap-row" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {canManage ? (
          <Link href="/settings/billing?correio=1" className="ms-btn ms-btn-primary">
            {t("cta")}
          </Link>
        ) : null}
        <a href="/correio" className="ms-btn ms-btn-secondary">
          {t("learn")}
        </a>
      </div>
      {teams.data && !canManage ? (
        <p style={{ margin: "16px 0 0", color: "var(--ms-muted)", fontSize: 13 }}>
          {t("adminOnly")}
        </p>
      ) : null}
    </section>
  );
}
