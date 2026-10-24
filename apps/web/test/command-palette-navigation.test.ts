import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/command-palette";
import {
  type NavigationPolicy,
  type PolicyRead,
  paletteMove,
  paletteSelection,
  productNavigation,
  productPaletteGroups,
  useProductNavigation,
} from "@/lib/product-navigation";
import enCommon from "../messages/en/common.json";
import enNav from "../messages/en/nav.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptNav from "../messages/pt-BR/nav.json";

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  operator: false,
  operational: false,
  directory: false,
  role: "admin" as "owner" | "admin" | "member" | undefined,
  profile: "success" as "success" | "pending" | "paused" | "error",
  cached: false,
  teamError: false,
  offered: false,
  enabled: true,
  retry: vi.fn(async () => ({})),
  cancel: vi.fn(async () => {}),
}));

// Only initialize the palette as open for SSR; production hooks/policy/rendering are real.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(initial === false ? true : initial),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const nav = state.locale === "en" ? enNav : ptNav;
    const common = state.locale === "en" ? enCommon : ptCommon;
    const root = namespace === "nav" ? nav : common.commandPalette;
    return key
      .split(".")
      .reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], root) as string;
  },
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    system: { operator: { queryOptions: () => ({ query: "operator", queryKey: ["operator"] }) } },
    team: { list: { queryOptions: () => ({ query: "team", queryKey: ["team"] }) } },
    mailboxes: { capabilities: { queryOptions: () => ({ query: "mail" }) } },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: state.cancel }),
  useQuery: (options: { query: string }) => ({
    data:
      options.query === "operator"
        ? state.profile !== "success" && !state.cached
          ? undefined
          : {
              isOperator: state.operator,
              isOperationsMember: state.operational,
              canReadUsers: state.directory,
            }
        : options.query === "team"
          ? state.role === undefined
            ? undefined
            : {
                activeTeamId: "active",
                teams: [{ teamId: "active", role: state.role }],
              }
          : { enabled: state.enabled, offered: state.offered },
    isError:
      options.query === "operator"
        ? state.profile === "error"
        : options.query === "team" && state.teamError,
    isPending: options.query === "operator" && state.profile === "pending",
    fetchStatus: options.query === "operator" && state.profile === "paused" ? "paused" : "idle",
    refetch: state.retry,
  }),
}));

beforeEach(() => {
  Object.assign(state, {
    locale: "en",
    operator: false,
    operational: false,
    directory: false,
    role: "admin",
    profile: "success",
    cached: false,
    teamError: false,
    offered: false,
    enabled: true,
  });
  state.retry.mockClear();
  state.cancel.mockClear();
});

const policy: NavigationPolicy = {
  isOperator: false,
  isOperationsMember: false,
  canReadUsers: false,
};
function menu(read: PolicyRead<NavigationPolicy>, role: "owner" | "admin" | "member" = "admin") {
  return productNavigation({
    policy: read,
    role: { data: role },
    mailbox: { data: { enabled: true } },
  });
}
const render = () => renderToStaticMarkup(createElement(CommandPalette));
const text = (value: string) =>
  renderToStaticMarkup(createElement("span", null, value)).replace(/^<span>|<\/span>$/g, "");

for (const locale of ["en", "pt-BR"] as const) {
  describe(`command palette navigation (${locale})`, () => {
    beforeEach(() => {
      state.locale = locale;
    });
    it("renders permitted team-admin navigation/actions with translated labels and keyboard hints", () => {
      const html = render();
      const common = locale === "en" ? enCommon : ptCommon;
      const nav = locale === "en" ? enNav : ptNav;
      expect(html).toContain('role="dialog"');
      for (const label of [
        nav.products.send,
        nav.domains,
        common.commandPalette.createApiKey,
        common.commandPalette.addDomain,
        common.commandPalette.hintNavigate,
        common.commandPalette.hintOpen,
      ])
        expect(html).toContain(text(label));
      expect(html).not.toContain(text(nav.console));
    });
    it.each([
      "operational",
      "pending",
      "paused",
      "error",
      "cached-error",
      "role-pending",
      "role-error",
    ] as const)("removes private navigation and creation actions for %s", (scenario) => {
      if (scenario === "operational") state.operational = true;
      else if (scenario === "role-pending") state.role = undefined;
      else if (scenario === "role-error") state.teamError = true;
      else if (scenario === "cached-error") {
        state.profile = "error";
        state.cached = true;
      } else state.profile = scenario;
      const html = render();
      const common = locale === "en" ? enCommon : ptCommon;
      const nav = locale === "en" ? enNav : ptNav;
      for (const label of [
        nav.products.send,
        nav.domains,
        common.commandPalette.createApiKey,
        common.commandPalette.addDomain,
      ])
        expect(html).not.toContain(`>${text(label)}<`);
      expect(html).toContain(text(nav.settings));
      expect(html).toContain(text(nav.mailboxes));
      if (scenario !== "operational") {
        expect(html).toContain(text(nav.recovery.retry));
        expect(html).toContain(scenario.includes("error") ? 'role="alert"' : 'role="status"');
        expect(html).not.toMatch(/<button[^>]*disabled/);
      }
    });
    it("retains ordinary-member read navigation without offering administrative creation", () => {
      state.role = "member";
      const nav = locale === "en" ? enNav : ptNav;
      const common = locale === "en" ? enCommon : ptCommon;
      const html = render();
      for (const label of [nav.products.send, nav.emails, nav.domains, nav.apiKeys])
        expect(html).toContain(text(label));
      for (const label of [common.commandPalette.createApiKey, common.commandPalette.addDomain])
        expect(html).not.toContain(`>${text(label)}<`);
    });
    it("renders delegated directory access without offering Console or Send", () => {
      state.directory = true;
      state.operational = true;
      state.role = "member";
      const nav = locale === "en" ? enNav : ptNav;
      const html = render();
      expect(html).toContain(text(nav.usersDirectory));
      expect(html).not.toContain(text(nav.console));
      state.operator = true;
      expect(render()).toContain(text(nav.console));
      expect(render()).not.toContain(text(nav.usersDirectory));
    });
    it("uses the same offered Mail capability as the sidebar", () => {
      state.enabled = false;
      state.offered = true;
      const nav = locale === "en" ? enNav : ptNav;
      expect(render()).toContain(text(nav.mailboxes));
      state.offered = false;
      expect(render()).not.toContain(`>${text(nav.mailboxes)}<`);
    });
  });
}

describe("pure navigation behavior", () => {
  it("retries only the failed policy/team reads through their exact shared query keys", async () => {
    state.profile = "error";
    state.teamError = true;
    let retry: (() => Promise<void>) | undefined;
    function RecoveryProbe() {
      retry = useProductNavigation().retry;
      return null;
    }
    renderToStaticMarkup(createElement(RecoveryProbe));
    expect(retry).toBeDefined();
    await retry?.();
    expect(state.cancel.mock.calls).toEqual([
      [{ queryKey: ["operator"], exact: true }],
      [{ queryKey: ["team"], exact: true }],
    ]);
    expect(state.retry).toHaveBeenCalledTimes(2);
  });
  it("does not infer instance-operator authority from a team owner or admin role", () => {
    for (const role of ["owner", "admin"] as const) {
      const navigation = menu({ data: policy }, role);
      expect(navigation.showConsole).toBe(false);
      expect(navigation.showDirectory).toBe(false);
    }
  });
  it.each(["owner", "admin"] as const)(
    "permits creation only for a confirmed ordinary %s",
    (role) => {
      expect(menu({ data: policy }, role).actions.map((item) => item.href)).toEqual([
        "/api-keys",
        "/domains/new",
      ]);
      expect(menu({ data: { ...policy, isOperationsMember: true } }, role).actions).toEqual([]);
    },
  );
  it("fails closed on retained cached data after a policy error or pause", () => {
    for (const query of [
      { data: policy, isError: true },
      { data: policy, fetchStatus: "paused" },
    ]) {
      const navigation = menu(query);
      expect(navigation.actions).toEqual([]);
      expect(navigation.sendItems).toEqual([]);
      expect(navigation.organizationItems.map((item) => item.href)).toEqual(["/settings"]);
    }
  });
  it("filters translated labels without resurrecting a forbidden action", () => {
    const groups = productPaletteGroups(
      menu({ data: policy }, "member"),
      (key) => key,
      (key) => key,
      "createApiKey",
    );
    expect(groups.flatMap((group) => group.items)).toEqual([]);
    const visible = productPaletteGroups(
      menu({ data: policy }),
      (key) => key,
      (key) => key,
      "  ADDDOMAIN  ",
    );
    expect(visible.flatMap((group) => group.items).map((item) => item.href)).toEqual([
      "/domains/new",
    ]);
  });
  it("wraps keyboard navigation and clamps selection after a policy/result shrink", () => {
    expect(paletteMove(0, 3, -1)).toBe(2);
    expect(paletteMove(2, 3, 1)).toBe(0);
    expect(paletteSelection(12, 2)).toBe(1);
    expect(paletteMove(12, 2, 1)).toBe(0);
    expect(paletteMove(0, 0, -1)).toBe(0);
    expect(paletteSelection(12, 0)).toBe(0);
  });
});
