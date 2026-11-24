"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AuditView, useActionLabel, useAuditQuery } from "@/components/console/audit/audit-view";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { useUrlState } from "@/lib/url-state";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConsoleAuditPage() {
  const t = useTranslations("console.audit");
  const common = useTranslations("console.common");
  const [action, setAction] = useUrlState("action", "all");
  const [team, setTeam] = useUrlState("team");
  const [limit, setLimit] = useState(25);
  const hasTeam = UUID.test(team);
  const query = useAuditQuery(action, limit, hasTeam ? team : "");
  const teamName = hasTeam ? query.data?.pages[0]?.team?.name : undefined;
  const actionLabel = useActionLabel();
  const actions = query.data?.pages[0]?.actions ?? [];
  const hasFilters = action !== "all" || hasTeam;
  return (
    <>
      <PageHeader
        title={t("title")}
        subtitle={t("proof")}
        actions={
          <>
            <div style={{ minWidth: 180 }}>
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
            </div>
            {hasFilters ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                onClick={() => {
                  setAction("all");
                  setTeam("");
                }}
              >
                {common("clearFilters")}
              </button>
            ) : null}
          </>
        }
      />
      {hasTeam ? (
        <div style={{ marginBottom: 14 }}>
          <button
            type="button"
            className="ms-chip"
            style={{ cursor: "pointer" }}
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
