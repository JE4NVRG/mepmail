import { ADMIN_MCP_SCOPES } from "@millionsend/core/oauth-scopes";
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
type Role = "owner" | "admin" | "member";
const scopes = ["mailboxes:read", ...ADMIN_MCP_SCOPES];
function render(locale: "en" | "pt-BR", roles: Role[], defaultTeamId = "team-0") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { auth: locale === "en" ? enAuth : ptAuth },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(ConsentForm, {
        app: null,
        userEmail: "member@example.invalid",
        scopes,
        teams: roles.map((role, index) => ({
          teamId: `team-${index}`,
          teamName: `Team ${index}`,
          role,
        })),
        defaultTeamId,
      }),
    }),
  );
}

describe.each(["en", "pt-BR"] as const)("OAuth administrative scope parity (%s)", (locale) => {
  const labels = (locale === "en" ? enAuth : ptAuth).consent.scopes;
  const label = (scope: string) => labels[scope.replace(":", "_") as keyof typeof labels];
  it("withholds every server-admin permission from an ordinary member, including mailbox provisioning", () => {
    expect(ADMIN_MCP_SCOPES).toContain("mailboxes:write");
    const html = render(locale, ["member"]);
    for (const scope of ADMIN_MCP_SCOPES) expect(html).not.toContain(label(scope));
    expect(html).toContain(label("mailboxes:read"));
  });
  it.each(["owner", "admin"] as const)(
    "offers the same administrative scope catalog to a %s",
    (role) => {
      const html = render(locale, [role]);
      for (const scope of ADMIN_MCP_SCOPES) expect(html).toContain(label(scope));
    },
  );
  it("treats all-teams membership as member-only when every membership is ordinary", () => {
    const html = render(locale, ["member", "member"], "*");
    for (const scope of ADMIN_MCP_SCOPES) expect(html).not.toContain(label(scope));
  });
  it("does not borrow an admin role from a different selected team", () => {
    const html = render(locale, ["member", "owner"], "team-0");
    for (const scope of ADMIN_MCP_SCOPES) expect(html).not.toContain(label(scope));
  });
});
