import { NextIntlClientProvider } from "next-intl";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/sidebar";
import enCommon from "../messages/en/common.json";
import enNav from "../messages/en/nav.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptNav from "../messages/pt-BR/nav.json";

const state = vi.hoisted(() => ({
  pathname: "/mailboxes",
  mailEnabled: true as boolean | undefined,
  operator: true,
  canReadUsers: false,
  isOperationsMember: false as boolean | undefined,
  profile: "success" as "success" | "pending" | "paused" | "error",
  cachedProfile: false,
  role: "owner" as "owner" | "admin" | "member" | undefined,
  teamError: false,
  mailOffered: false,
  retry: vi.fn(async () => ({})),
  cancel: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    system: { operator: { queryOptions: () => ({ query: "operator", queryKey: ["operator"] }) } },
    mailboxes: { capabilities: { queryOptions: () => ({ query: "mailboxes" }) } },
    team: { list: { queryOptions: () => ({ query: "team", queryKey: ["team"] }) } },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ cancelQueries: state.cancel }),
  useQuery: (options: { query: string }) => ({
    data:
      options.query === "operator"
        ? state.profile !== "success" && !state.cachedProfile
          ? undefined
          : {
              isOperator: state.operator,
              canReadUsers: state.canReadUsers,
              isOperationsMember: state.isOperationsMember,
            }
        : options.query === "team"
          ? state.role === undefined
            ? undefined
            : {
                activeTeamId: "active",
                teams: [{ teamId: "active", role: state.role }],
              }
          : state.mailEnabled === undefined
            ? undefined
            : { enabled: state.mailEnabled, offered: state.mailOffered },
    isPending: options.query === "operator" && ["pending", "paused"].includes(state.profile),
    isError:
      (options.query === "operator" && state.profile === "error") ||
      (options.query === "team" && state.teamError),
    fetchStatus: options.query === "operator" && state.profile === "paused" ? "paused" : "idle",
    refetch: state.retry,
  }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/components/popover-menu", () => ({ useDismiss: () => {} }));
vi.mock("@/components/team-switcher", () => ({ TeamSwitcher: () => null }));
vi.mock("@/components/user-avatar", () => ({ UserAvatar: () => null }));

beforeEach(() => {
  state.pathname = "/mailboxes";
  state.mailEnabled = true;
  state.operator = true;
  state.canReadUsers = false;
  state.isOperationsMember = false;
  state.profile = "success";
  state.cachedProfile = false;
  state.role = "owner";
  state.teamError = false;
  state.mailOffered = false;
  state.retry.mockClear();
  state.cancel.mockClear();
});

function navMarkup(locale: "en" | "pt-BR") {
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages:
        locale === "en" ? { nav: enNav, common: enCommon } : { nav: ptNav, common: ptCommon },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(Sidebar, {
        teamName: "MepMail",
        userEmail: "operator@example.com",
        className: "ms-sidebar",
      }),
    }),
  );
  return { html, nav: html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0] ?? "" };
}

function hrefs(markup: string) {
  return [...markup.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

for (const locale of ["en", "pt-BR"] as const) {
  describe(`stable Sidebar navigation (${locale})`, () => {
    it.each(["pending", "paused", "error"] as const)(
      "explains the unresolved %s profile with a reachable retry and keeps private links hidden",
      (profile) => {
        state.profile = profile;
        state.operator = false;
        const { nav } = navMarkup(locale);
        const messages = locale === "en" ? enNav : ptNav;
        const message = messages.recovery[profile === "pending" ? "loading" : profile];
        expect(nav).toContain(renderToStaticMarkup(createElement(Fragment, null, message)));
        expect(nav).toContain(messages.recovery.retry);
        expect(nav).toContain(profile === "error" ? 'role="alert"' : 'role="status"');
        expect(nav).not.toMatch(/<button[^>]*disabled/);
        for (const href of ["/emails", "/domains", "/api-keys", "/console"])
          expect(hrefs(nav)).not.toContain(href);
      },
    );

    it("does not trust cached policy privileges when a background policy check fails", () => {
      state.profile = "error";
      state.cachedProfile = true;
      state.operator = false;
      const { nav } = navMarkup(locale);
      expect(hrefs(nav)).not.toContain("/emails");
      expect(hrefs(nav)).not.toContain("/domains");
      expect(hrefs(nav)).toContain("/settings");
      expect(nav).toContain('role="alert"');
    });
    it.each([undefined] as const)("hides private tools for an unresolved role (%s)", (role) => {
      state.operator = false;
      state.role = role;
      const { nav } = navMarkup(locale);
      for (const href of ["/emails", "/domains", "/api-keys", "/webhooks", "/console"])
        expect(hrefs(nav)).not.toContain(href);
      expect(hrefs(nav)).toContain("/settings");
      expect(hrefs(nav)).toContain("/mail");
    });
    it("retains permitted ordinary-member read routes after the default /emails login", () => {
      state.operator = false;
      state.role = "member";
      const links = hrefs(navMarkup(locale).nav);
      for (const href of ["/emails", "/domains", "/api-keys", "/settings", "/mail"])
        expect(links).toContain(href);
      expect(links).not.toContain("/console");
    });
    it("shows a retry and hides privileged links after the team role read fails", () => {
      state.operator = false;
      state.teamError = true;
      const { nav } = navMarkup(locale);
      expect(nav).toContain('role="alert"');
      expect(hrefs(nav)).not.toContain("/emails");
      expect(hrefs(nav)).not.toContain("/domains");
    });
    it("includes an offered Mail product before activation", () => {
      state.mailEnabled = false;
      state.mailOffered = true;
      expect(hrefs(navMarkup(locale).nav)).toContain("/mail");
    });
    it("preserves the full navigation and width when leaving Mail for a shared domain or settings page", () => {
      const first = navMarkup(locale);
      const initialLinks = hrefs(first.nav);
      expect(initialLinks).toContain("/mail");
      // Correio is its own full-window app: the menu opens it in a new tab.
      expect(first.nav).toMatch(
        /href="\/mail"[^>]*target="_blank"|target="_blank"[^>]*href="\/mail"/,
      );
      expect(initialLinks).toContain("/emails");
      expect(initialLinks.filter((href) => href === "/domains")).toHaveLength(1);
      expect(initialLinks.filter((href) => href === "/settings")).toHaveLength(1);
      expect(initialLinks).toContain("https://docs.mepmail.dev");
      expect(initialLinks).toContain("/source");
      // Document navigation to the page that loads and opens the support chat.
      expect(initialLinks).toContain("/support#chat");
      for (const pathname of ["/domains/new", "/settings/connected-apps", "/emails/123"]) {
        state.pathname = pathname;
        const { html, nav } = navMarkup(locale);
        expect(hrefs(nav)).toEqual(initialLinks);
        expect(html.match(/<aside[^>]*style="([^"]+)"/)?.[1]).toBe(
          first.html.match(/<aside[^>]*style="([^"]+)"/)?.[1],
        );
        expect(html).toContain("width:240px");
      }
    });

    it.each([
      ["/mail", "/mail"],
      ["/mail/settings", "/mail"],
      ["/domains/new", "/domains"],
      ["/settings/connected-apps", "/settings"],
      ["/emails/123", "/emails"],
      ["/console/safety", "/console"],
    ])("highlights only the current route for %s", (pathname, expected) => {
      state.pathname = pathname;
      const activeLinks = [...navMarkup(locale).nav.matchAll(/<a\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((tag) => tag.includes('aria-current="page"'));
      expect(activeLinks).toHaveLength(1);
      expect(activeLinks[0]).toContain(`href="${expected}"`);
    });

    it.each([false, undefined])(
      "does not expose Mail before its capability is enabled (%s)",
      (enabled) => {
        state.mailEnabled = enabled;
        const { nav } = navMarkup(locale);
        expect(hrefs(nav)).not.toContain("/mail");
        expect(hrefs(nav)).toContain("/emails");
        expect(hrefs(nav)).toContain("/domains");
        expect(nav).not.toContain(`aria-label="${locale === "en" ? "Mail" : "Correio"}"`);
      },
    );

    it("keeps the Console operator-only while retaining the shared organization links", () => {
      state.operator = false;
      const { nav } = navMarkup(locale);
      expect(hrefs(nav)).not.toContain("/console");
      expect(hrefs(nav)).toContain("/domains");
      expect(hrefs(nav)).toContain("/settings");
      expect(nav).toContain(`aria-label="${locale === "en" ? "Mail" : "Correio"}"`);
      expect(nav).toContain(`aria-label="${locale === "en" ? "Send" : "Envio"}"`);
      expect(nav).toContain(`aria-label="${locale === "en" ? "Organization" : "Organização"}"`);
    });

    it("shows only the read-only directory link to a delegated reader", () => {
      state.operator = false;
      state.canReadUsers = true;
      state.isOperationsMember = true;
      state.pathname = "/operations/users";
      const { nav } = navMarkup(locale);
      expect(hrefs(nav)).toContain("/operations/users");
      expect(hrefs(nav)).not.toContain("/console");
      const directoryLink = nav.match(/<a\b[^>]*href="\/operations\/users"[^>]*>/)?.[0];
      expect(directoryLink).toContain('aria-current="page"');
    });

    it.each([true, undefined])(
      "keeps Send and domain tools out of scoped or unresolved navigation (%s)",
      (isOperationsMember) => {
        state.operator = false;
        state.isOperationsMember = isOperationsMember;
        const links = hrefs(navMarkup(locale).nav);
        expect(links).toContain("/mail");
        expect(links).toContain("/settings");
        expect(links).toContain("/support#chat");
        for (const href of [
          "/emails",
          "/broadcasts",
          "/templates",
          "/audience",
          "/metrics",
          "/domains",
          "/logs",
          "/api-keys",
          "/webhooks",
          "/console",
          "/settings/billing",
        ])
          expect(links).not.toContain(href);
      },
    );

    it("restores ordinary navigation after switching to a team without the operational profile", () => {
      state.operator = false;
      state.isOperationsMember = true;
      expect(hrefs(navMarkup(locale).nav)).not.toContain("/emails");
      state.isOperationsMember = false;
      expect(hrefs(navMarkup(locale).nav)).toContain("/emails");
      expect(hrefs(navMarkup(locale).nav)).toContain("/domains");
    });

    it("does not add the delegated route to an operator or an ordinary member", () => {
      state.canReadUsers = true;
      expect(hrefs(navMarkup(locale).nav)).toContain("/console");
      expect(hrefs(navMarkup(locale).nav)).not.toContain("/operations/users");
      state.operator = false;
      state.canReadUsers = false;
      expect(hrefs(navMarkup(locale).nav)).not.toContain("/operations/users");
    });
  });
}
