import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
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
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    system: { operator: { queryOptions: () => ({ query: "operator" }) } },
    mailboxes: { capabilities: { queryOptions: () => ({ query: "mailboxes" }) } },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { query: string }) => ({
    data:
      options.query === "operator"
        ? { isOperator: state.operator }
        : state.mailEnabled === undefined
          ? undefined
          : { enabled: state.mailEnabled },
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
    it("preserves the full navigation and width when leaving Mail for a shared domain or settings page", () => {
      const first = navMarkup(locale);
      const initialLinks = hrefs(first.nav);
      expect(initialLinks).toContain("/mail");
      // Correio is its own full-window app: the menu opens it in a new tab.
      expect(first.nav).toMatch(/href="\/mail"[^>]*target="_blank"|target="_blank"[^>]*href="\/mail"/);
      expect(initialLinks).toContain("/emails");
      expect(initialLinks.filter((href) => href === "/domains")).toHaveLength(1);
      expect(initialLinks.filter((href) => href === "/settings")).toHaveLength(1);
      expect(initialLinks).toContain("https://docs-mepmail.je4ndev.com");
      expect(initialLinks).toContain("/source");
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
  });
}
