import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsersView } from "@/components/console/users/users-view";
import enCommon from "../messages/en/common.json";
import enConsole from "../messages/en/console.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptConsole from "../messages/pt-BR/console.json";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({ console: { users: { list: { queryKey: () => ["users"] } } } }),
  useTRPCClient: () => ({ console: { users: { list: { query: vi.fn() } } } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: () => ({
    isSuccess: true,
    isPending: false,
    isError: false,
    hasNextPage: false,
    data: {
      pages: [
        {
          total: 1,
          verified: 1,
          items: [
            {
              id: "synthetic-user",
              name: "Synthetic user",
              email: "person@synthetic.invalid",
              emailVerified: true,
              teams: 2,
              teamNames: ["Private synthetic team"],
              sent30d: 12,
              createdAt: new Date("2026-10-17T12:00:00Z"),
              lastSeenAt: null,
              isOperator: false,
            },
          ],
        },
      ],
    },
  }),
}));

for (const [locale, common, messages] of [
  ["en", enCommon, enConsole],
  ["pt-BR", ptCommon, ptConsole],
] as const) {
  function render(readOnly?: boolean) {
    return renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        timeZone: "UTC",
        messages: { common, console: messages },
        // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
        children: createElement<{ readOnly?: boolean }>(
          UsersView,
          readOnly === undefined ? {} : { readOnly },
        ),
      }),
    );
  }

  describe(`operational user directory (${locale})`, () => {
    it("keeps the searchable directory but exposes no team administration or export", () => {
      const html = render(true);
      expect(html).toContain(messages.users.readOnly);
      expect(html).toContain("Synthetic user");
      expect(html).toContain("person@synthetic.invalid");
      expect(html).toContain('type="text"');
      expect(html).not.toContain('href="/console');
      expect(html).not.toContain("Private synthetic team");
      expect(html).not.toContain("download=");
      expect(html).not.toContain("text/csv");
    });

    it("preserves the operator's team link by default", () => {
      const html = render();
      expect(html).toContain('href="/console/teams?q=person%40synthetic.invalid"');
      expect(html).not.toContain(messages.users.readOnly);
    });
  });
}
