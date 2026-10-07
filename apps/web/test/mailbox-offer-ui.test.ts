import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes.json";
import pt from "../messages/pt-BR/mailboxes.json";
import { MailboxOffer } from "../src/app/(dashboard)/mailboxes/mailbox-offer";

const fixture = vi.hoisted(() => ({ role: "owner" as string | null }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data:
      fixture.role === null
        ? undefined
        : { activeTeamId: "team_1", teams: [{ teamId: "team_1", role: fixture.role }] },
  }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({ team: { list: { queryOptions: () => ({ kind: "team.list" }) } } }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));

const messages = { en: { mailboxes: en }, "pt-BR": { mailboxes: pt } } as const;
function render(locale: keyof typeof messages) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messages[locale],
      timeZone: "UTC",
      // biome-ignore lint/correctness/noChildrenProp: NextIntlClientProvider requires a typed children property with createElement.
      children: createElement(MailboxOffer),
    }),
  );
}
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  fixture.role = "owner";
});

describe("Correio offer for teams without access", () => {
  it.each(["en", "pt-BR"] as const)("presents prices and the combo deep link in %s", (locale) => {
    const html = render(locale);
    const visible = text(html);
    const sep = locale === "en" ? "." : ",";
    expect(visible).toContain(`$5${sep}90`);
    expect(visible).toContain(`$9${sep}90`);
    expect(visible).toContain("$29");
    expect(visible).toContain("$20");
    expect(html).toContain('href="/settings/billing?correio=1"');
    expect(html).toContain('href="/correio"');
  });

  it("does not offer the purchase link to members who cannot manage billing", () => {
    fixture.role = "member";
    const html = render("pt-BR");
    expect(html).not.toContain("/settings/billing");
    expect(text(html)).toContain(pt.offer.adminOnly);
    expect(html).toContain('href="/correio"');
  });
});
