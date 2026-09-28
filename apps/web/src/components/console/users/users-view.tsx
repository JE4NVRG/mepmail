"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useDeferredValue, useMemo, useState } from "react";
import { ListFooter } from "@/components/list-footer";
import { PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { Skeleton } from "@/components/skeleton";
import { SortableTh, type SortDir } from "@/components/sortable-th";
import { Table } from "@/components/table";
import { formatDay, formatDayTime } from "@/lib/format";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { oneOf, useUrlState } from "@/lib/url-state";
import type { UserRow } from "./types";

const SORT_KEYS = ["name", "email", "teams", "sent30d", "joined", "seen"] as const;
const VERIFIED = ["yes", "no"] as const;
const COLUMNS = 7;

/** Mirrors a loaded row: avatar + name, e-mail, three figures, two days. */
function SkeletonRows() {
  return (
    <tbody>
      {[140, 110, 150, 130, 120, 160].map((width) => (
        <tr key={width}>
          <td>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Skeleton width={26} height={26} radius={8} />
              <Skeleton width={width} height={13} />
            </span>
          </td>
          <td>
            <Skeleton width={160} />
          </td>
          {[28, 48, 56].map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells, position is identity
            <td key={i} className="right">
              <Skeleton width={w} />
            </td>
          ))}
          <td>
            <Skeleton width={72} />
          </td>
          <td>
            <Skeleton width={112} />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/** The person's initial, in the same box the shell's account menu uses. */
function UserAvatar({ name, email }: { name: string; email: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 26,
        height: 26,
        borderRadius: 8,
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 600,
        flex: "none",
      }}
    >
      {(name || email).charAt(0).toUpperCase()}
    </span>
  );
}

export function UsersView() {
  const t = useTranslations("console.users");
  const common = useTranslations("console.common");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const trpc = useTRPC();
  const client = useTRPCClient();

  const [search, setSearch] = useUrlState("q");
  const [verifiedParam, setVerified] = useUrlState("verified", "all");
  const [sortParam, setSort] = useUrlState("sort", "joined");
  const [dirParam, setDir] = useUrlState("dir", "desc");
  const [limit, setLimit] = useState(25);
  const deferredSearch = useDeferredValue(search.trim());

  // URL params are untrusted: anything outside the router's enums reads as the default.
  const verified = oneOf(VERIFIED, verifiedParam, "all");
  const sort = oneOf(SORT_KEYS, sortParam, "joined");
  const dir: SortDir = oneOf(["asc", "desc"] as const, dirParam, "desc");

  const input = {
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(verified !== "all" ? { verified } : {}),
    sort,
    dir,
    limit,
  };
  // The router pages by offset, which tRPC's infinite helper (cursor-only) cannot drive.
  const list = useInfiniteQuery({
    queryKey: [...trpc.console.users.list.queryKey(input), "infinite"],
    queryFn: ({ pageParam }) => client.console.users.list.query({ ...input, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset,
  });

  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const verifiedCount = list.data?.pages[0]?.verified ?? 0;

  const onSort = (column: string, next: SortDir) => {
    setSort(column);
    setDir(next);
  };
  const sortable = (column: (typeof SORT_KEYS)[number], right = false, defaultDir?: SortDir) => (
    <SortableTh
      column={column}
      label={t(`columns.${column}`)}
      sort={sort}
      dir={dir}
      onSort={onSort}
      right={right}
      {...(defaultDir ? { defaultDir } : {})}
    />
  );

  const proof = list.isSuccess
    ? t("proof", { total: nf.format(total), verified: nf.format(verifiedCount) })
    : undefined;

  /** The teams screen already searches member e-mails, so the count opens the support view of them. */
  function TeamsCell({ row }: { row: UserRow }) {
    if (row.teams === 0) {
      return <span style={{ color: "var(--ms-muted)" }}>{common("none")}</span>;
    }
    return (
      <Link
        href={`/console/teams?q=${encodeURIComponent(row.email)}`}
        title={row.teamNames.join(", ")}
        style={{ color: "inherit" }}
      >
        {nf.format(row.teams)}
      </Link>
    );
  }

  return (
    <>
      <PageHeader title={t("title")} {...(proof ? { subtitle: proof } : {})} />

      <div
        className="ms-filter-row"
        style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}
      >
        <div style={{ flex: 1, minWidth: 160 }}>
          <input
            type="text"
            className="ms-input"
            style={{ width: "100%" }}
            placeholder={t("search")}
            aria-label={t("search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          value={verified}
          onChange={setVerified}
          ariaLabel={t("columns.verified")}
          options={[
            { value: "all", label: t("filters.verified", { value: t("filters.all") }) },
            ...VERIFIED.map((key) => ({
              value: key,
              label: t("filters.verified", { value: t(key) }),
            })),
          ]}
        />
      </div>

      {list.isError ? (
        <div
          className="ms-card"
          style={{ padding: 20, display: "flex", gap: 14, alignItems: "center" }}
        >
          <p style={{ margin: 0, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
            {common("loadError")}
          </p>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={() => list.refetch()}>
            {common("retry")}
          </button>
        </div>
      ) : (
        <div className="ms-card" style={{ padding: 0, overflow: "hidden" }}>
          <Table className="nowrap">
            <thead>
              <tr>
                {sortable("name", false, "asc")}
                {sortable("email", false, "asc")}
                {sortable("teams", true)}
                {sortable("sent30d", true)}
                {sortable("joined")}
                {sortable("seen")}
                <th>{t("columns.verified")}</th>
              </tr>
            </thead>
            {list.isPending ? (
              <SkeletonRows />
            ) : (
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={COLUMNS}
                      style={{ color: "var(--ms-muted)", padding: "18px 12px" }}
                    >
                      {t("empty")}
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                          <UserAvatar name={row.name} email={row.email} />
                          {row.name}
                          {row.isOperator ? (
                            <span className="ms-badge ms-badge-info">{t("operatorBadge")}</span>
                          ) : null}
                        </span>
                      </td>
                      <td
                        title={row.email}
                        style={{
                          color: "var(--ms-muted)",
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {row.email}
                      </td>
                      <td className="right num">
                        <TeamsCell row={row} />
                      </td>
                      <td className="right num" title={t("sentHint")}>
                        {nf.format(row.sent30d)}
                      </td>
                      <td style={{ color: "var(--ms-muted)" }}>
                        {formatDay(row.createdAt, locale)}
                      </td>
                      <td style={{ color: "var(--ms-muted)" }}>
                        {row.lastSeenAt ? formatDayTime(row.lastSeenAt, locale) : common("none")}
                      </td>
                      <td>
                        <span
                          className={`ms-badge ms-badge-${row.emailVerified ? "success" : "warn"}`}
                        >
                          {t(row.emailVerified ? "yes" : "no")}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </Table>
          {list.isSuccess ? (
            <div style={{ padding: "0 16px 14px", borderTop: "1px solid var(--ms-line)" }}>
              <ListFooter
                left={t("ofUsers", { shown: nf.format(rows.length), total: nf.format(total) })}
                size={limit}
                onSize={setLimit}
                sizeLabel={(size) => common("perPage", { n: size })}
                singlePage={!list.hasNextPage && list.data.pages.length === 1}
                loadMore={
                  list.hasNextPage
                    ? {
                        label: common("loadMore"),
                        onClick: () => void list.fetchNextPage(),
                        loading: list.isFetchingNextPage,
                      }
                    : undefined
                }
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
