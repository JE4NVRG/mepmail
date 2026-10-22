"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuditView, useActionLabel, useAuditQuery } from "@/components/console/audit/audit-view";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { useUrlState } from "@/lib/url-state";

export default function ConsoleAuditPage() {
  const t = useTranslations("console.audit");
  const [action, setAction] = useUrlState("action", "all");
  const [team, setTeam] = useUrlState("team");
  const [limit, setLimit] = useState(25);
  const query = useAuditQuery(action, limit, team);
  const teamName = team
    ? query.data?.pages[0]?.items.find((row) => row.teamId === team)?.teamName
    : undefined;
  const actionLabel = useActionLabel();
  const actions = query.data?.pages[0]?.actions ?? [];
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("proof")}
        actions={
          <Select
            value={action}
            onChange={setAction}
            ariaLabel={t("columns.action")}
            width="100%"
            options={[
              { value: "all", label: t("actionAll") },
              ...actions.map((value) => ({
                value,
                label: t("action", { value: actionLabel(value) }),
              })),
            ]}
          />
        }
      />
      {team ? (
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="ms-chip"
            onClick={() => setTeam("")}
            aria-label={t("clearTeam")}
          >
            {t("teamChip", { team: teamName ?? team.slice(0, 8) })} ×
          </button>
        </div>
      ) : null}
      <AuditView query={query} limit={limit} onLimit={setLimit} />
    </>
  );
}
