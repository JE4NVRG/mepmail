import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enAuth from "../messages/en/auth.json";
import ptAuth from "../messages/pt-BR/auth.json";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    team: { grantTeam: { mutationOptions: () => ({}) } },
    mailboxes: { grantOAuthClient: { mutationOptions: () => ({}) } },
  }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { oauth2: { consent: vi.fn() } } }));
vi.mock("@/components/auth/auth-screen", () => ({
  AuthScreen: ({ children }: { children?: ReactNode }) => createElement("main", null, children),
}));
vi.mock("next/link", () => ({ default: "a" }));

const { ConsentForm } = await import("../src/app/oauth/consent/consent-form");

const TEAM = "00000000-0000-4000-8000-0000000000aa";
function render(locale: "en" | "pt-BR") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { auth: locale === "en" ? enAuth : ptAuth },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(ConsentForm, {
        app: {
          clientId: "client-agent",
          name: "Hermes Agent",
          uri: null,
          redirectOrigins: [],
          unverified: true,
          registeredAt: null,
        },
        userEmail: "owner@example.test",
        scopes: ["mail:read", "mail:draft", "mail:send"],
        teams: [{ teamId: TEAM, teamName: "Team", role: "owner" }],
        defaultTeamId: TEAM,
        mailboxes: {
          [TEAM]: [
            { id: "box-personal", address: "me@example.test", label: "Me" },
            { id: "box-agent", address: "agent@example.test", label: "Agent" },
          ],
        },
      }),
    }),
  );
}

describe.each(["en", "pt-BR"] as const)("OAuth consent mailboxes (%s)", (locale) => {
  const consent = (locale === "en" ? enAuth : ptAuth).consent;
  it("starts with no mailbox ticked and says why Allow waits", () => {
    const html = render(locale);
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    // 2 mail scopes offered ticked (send never is) + 2 mailboxes, none of them ticked.
    const mailboxInputs = boxes.slice(-2);
    expect(mailboxInputs).toHaveLength(2);
    for (const input of mailboxInputs) expect(input).not.toMatch(/checked/);
    expect(html).toContain(consent.mailboxesChoose);
    expect(html).toContain(consent.mailboxesPick);
    expect(html).toContain(consent.mailboxesAll);
    // Allow is disabled until a mailbox is chosen.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});
