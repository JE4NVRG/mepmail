"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { NavIconName } from "@/components/icons/nav-icons";
import { type RecoveryPhase, recoverQuery } from "@/lib/query-recovery";
import { useTRPC } from "@/lib/trpc";

export type ProductNavItem = { key: string; href: string; icon: NavIconName };
export const NAV_ITEMS: readonly ProductNavItem[] = [
  { key: "emails", href: "/emails", icon: "emails" },
  { key: "broadcasts", href: "/broadcasts", icon: "broadcasts" },
  { key: "templates", href: "/templates", icon: "templates" },
  { key: "audience", href: "/audience", icon: "audience" },
  { key: "metrics", href: "/metrics", icon: "metrics" },
  { key: "domains", href: "/domains", icon: "domains" },
  { key: "logs", href: "/logs", icon: "logs" },
  { key: "apiKeys", href: "/api-keys", icon: "api-keys" },
  { key: "webhooks", href: "/webhooks", icon: "webhooks" },
  { key: "settings", href: "/settings", icon: "settings" },
];
export const MAIL_NAV_ITEM: ProductNavItem = { key: "mailboxes", href: "/mail", icon: "emails" };
export const CONSOLE_NAV_ITEM: ProductNavItem = {
  key: "console",
  href: "/console",
  icon: "console",
};
export const USERS_NAV_ITEM: ProductNavItem = {
  key: "usersDirectory",
  href: "/operations/users",
  icon: "audience",
};
export const ORGANIZATION_NAV_ITEMS = NAV_ITEMS.filter((item) =>
  ["domains", "settings"].includes(item.key),
);
export const SEND_NAV_ITEMS = NAV_ITEMS.filter((item) => !ORGANIZATION_NAV_ITEMS.includes(item));

export type NavigationPolicy = {
  isOperator: boolean;
  isOperationsMember: boolean;
  canReadUsers: boolean;
};
type TeamRole = "owner" | "admin" | "member";
export type PolicyRead<T> = {
  data?: T | undefined;
  isPending?: boolean;
  isError?: boolean;
  fetchStatus?: string;
};

/** Policy reads fail closed even when React Query retains an older successful value. */
export function navigationReadPhase<T>(query: PolicyRead<T>): RecoveryPhase | null {
  if (query.isError) return "error";
  if (query.fetchStatus === "paused") return "paused";
  if (query.isPending || query.data === undefined || query.data === null) return "loading";
  return null;
}

function navigationPolicyPhase(query: PolicyRead<NavigationPolicy>): RecoveryPhase | null {
  return (
    navigationReadPhase(query) ??
    (typeof query.data?.isOperationsMember === "boolean" &&
    typeof query.data?.isOperator === "boolean" &&
    typeof query.data?.canReadUsers === "boolean"
      ? null
      : "loading")
  );
}

/** Presentation only: the live server checks remain the authorization boundary. */
export function productNavigation({
  policy,
  role,
  mailbox,
}: {
  policy: PolicyRead<NavigationPolicy>;
  role: PolicyRead<TeamRole>;
  mailbox: PolicyRead<{ enabled?: boolean; offered?: boolean }>;
}) {
  const policyPhase = navigationPolicyPhase(policy);
  const rolePhase = navigationReadPhase(role);
  const knownPolicy = policyPhase === null ? policy.data : undefined;
  // Ordinary members retain the read-only dashboard routes the server allows;
  // only administrative creation actions require owner/admin membership.
  const showSending =
    knownPolicy?.isOperationsMember === false &&
    rolePhase === null &&
    (role.data === "owner" || role.data === "admin" || role.data === "member");
  const canAdminister = showSending && (role.data === "owner" || role.data === "admin");
  const showConsole = knownPolicy?.isOperator === true;
  const showDirectory = knownPolicy?.canReadUsers === true && !showConsole;
  const organizationItems = ORGANIZATION_NAV_ITEMS.filter(
    (item) => item.key === "settings" || showSending,
  );
  if (showConsole) organizationItems.push(CONSOLE_NAV_ITEM);
  else if (showDirectory) organizationItems.push(USERS_NAV_ITEM);
  // A role failure must not be masked by another still-pending policy read.
  const phases = [policyPhase, rolePhase];
  const recoveryPhase = phases.includes("error")
    ? "error"
    : phases.includes("paused")
      ? "paused"
      : phases.includes("loading")
        ? "loading"
        : null;
  return {
    showSending,
    canAdminister,
    showConsole,
    showDirectory,
    mailEnabled:
      navigationReadPhase(mailbox) === null &&
      (mailbox.data?.enabled === true || mailbox.data?.offered === true),
    sendItems: showSending ? SEND_NAV_ITEMS : [],
    organizationItems,
    actions: canAdminister
      ? [
          { key: "createApiKey", href: "/api-keys" },
          { key: "addDomain", href: "/domains/new" },
        ]
      : [],
    recoveryPhase: recoveryPhase as RecoveryPhase | null,
  };
}

/** Both surfaces subscribe to the same team-scoped cache keys and recovery policy. */
export function useProductNavigation() {
  const trpc = useTRPC();
  const queries = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const operatorOptions = trpc.system.operator.queryOptions();
  const teamOptions = trpc.team.list.queryOptions();
  const operator = useQuery(operatorOptions);
  const team = useQuery(teamOptions);
  const mailbox = useQuery(trpc.mailboxes.capabilities.queryOptions());
  const role = team.data?.teams.find((member) => member.teamId === team.data?.activeTeamId)?.role;
  const roleRead: PolicyRead<TeamRole> = {
    data: role,
    isPending: team.isPending,
    isError: team.isError || (team.data !== undefined && role === undefined),
    fetchStatus: team.fetchStatus,
  };
  const navigation = productNavigation({ policy: operator, role: roleRead, mailbox });
  const retry = async () => {
    // Serial exact-key retries do not cancel another product's reads or broaden access.
    if (navigationPolicyPhase(operator)) {
      await recoverQuery(
        queries,
        operatorOptions.queryKey,
        () => operator.refetch(),
        () => mounted.current,
      );
    }
    if (navigationReadPhase(roleRead)) {
      await recoverQuery(
        queries,
        teamOptions.queryKey,
        () => team.refetch(),
        () => mounted.current,
      );
    }
  };
  return { ...navigation, retry };
}

export type PaletteItem = { id: string; label: string; href: string };
export function productPaletteGroups(
  navigation: ReturnType<typeof productNavigation>,
  tNav: (key: string) => string,
  t: (key: string) => string,
  query: string,
) {
  const q = query.trim().toLowerCase();
  const matches = (items: PaletteItem[]) =>
    q ? items.filter((item) => item.label.toLowerCase().includes(q)) : items;
  const items = (rows: readonly { key: string; href: string }[]) =>
    matches(rows.map((item) => ({ id: item.key, label: tNav(item.key), href: item.href })));
  return [
    { id: "send", label: tNav("products.send"), items: items(navigation.sendItems) },
    {
      id: "mail",
      label: tNav("products.mail"),
      items: items(navigation.mailEnabled ? [MAIL_NAV_ITEM] : []),
    },
    {
      id: "organization",
      label: tNav("products.organization"),
      items: items(navigation.organizationItems),
    },
    {
      id: "actions",
      label: t("actions"),
      items: matches(
        navigation.actions.map((item) => ({
          id: item.key,
          label: t(item.key),
          href: item.href,
        })),
      ),
    },
  ];
}

/** Clamp a selection after an asynchronous policy change or shortened result list. */
export function paletteSelection(index: number, length: number): number {
  return length ? Math.min(Math.max(index, 0), length - 1) : 0;
}
export function paletteMove(index: number, length: number, direction: 1 | -1): number {
  return length ? (paletteSelection(index, length) + direction + length) % length : 0;
}
