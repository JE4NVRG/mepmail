import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_NAV, ConsoleShell } from "@/components/console/console-shell";
import { pickActive } from "@/lib/nav";
import enCommon from "../messages/en/common.json";
import enConsole from "../messages/en/console.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptConsole from "../messages/pt-BR/console.json";

const navigation = vi.hoisted(() => ({ pathname: "/console", push: vi.fn(), refresh: vi.fn() }));
const signOut = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation,
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut } }));
vi.mock("@/components/sidebar", () => ({ AppearanceRow: () => null, LanguageRow: () => null }));
vi.mock("@/components/popover-menu", () => ({ useDismiss: () => {} }));

beforeEach(() => vi.clearAllMocks());

for (const [locale, common, consoleMessages, label] of [
  ["en", enCommon, enConsole, "Back to dashboard"],
  ["pt-BR", ptCommon, ptConsole, "Voltar ao painel"],
] as const) {
  describe(`ConsoleShell (${locale})`, () => {
    it.each(CONSOLE_NAV.map(({ href }) => href))(
      "offers a fixed dashboard link on direct entry to %s without opening the account menu",
      (pathname) => {
        navigation.pathname = pathname;
        const html = renderToStaticMarkup(
          createElement(NextIntlClientProvider, {
            locale,
            timeZone: "UTC",
            messages: { common, console: consoleMessages },
            // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
            children: createElement(ConsoleShell, {
              userEmail: "operator@example.com",
              // biome-ignore lint/correctness/noChildrenProp: ConsoleShell requires children in its props type.
              children: null,
            }),
          }),
        );
        // This same sidebar is the desktop nav and the off-canvas mobile drawer.
        expect(html).toMatch(/<aside class="ms-sidebar"/);
        expect(html).toMatch(new RegExp(`<a[^>]*href="/emails"[^>]*>[^<]*${label}</a>`));
        expect(html).not.toContain('role="menu"');
        expect(html).not.toContain('href="/login"');
        expect(signOut).not.toHaveBeenCalled();
        expect(navigation.push).not.toHaveBeenCalled();
        expect(navigation.refresh).not.toHaveBeenCalled();
      },
    );

    it("keeps the console screen active, not the dashboard return link", () => {
      const paths = CONSOLE_NAV.map(({ href }) => href);
      expect(pickActive("/console/regions", paths)).toBe("/console/regions");
      expect(pickActive("/emails", paths)).toBeUndefined();
    });
  });
}
