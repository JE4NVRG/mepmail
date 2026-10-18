import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/settings.json";
import pt from "../messages/pt-BR/settings.json";
import AcceptInvitePage from "../src/app/invite/[token]/page";

const fixture = vi.hoisted(() => ({
  operationsProfile: true,
  role: "member" as "member" | "admin",
  signedIn: false,
  push: vi.fn(),
  onSuccess: null as ((joined: { teamId: string }) => void) | null,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "synthetic-invitation" }),
  useRouter: () => ({ push: fixture.push }),
}));
vi.mock("@/components/auth-shell", () => ({
  AuthShell: ({ children }: { children: ReactNode }) => createElement("main", null, children),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: fixture.signedIn ? { user: { email: "viewer@synthetic.invalid" } } : null,
      isPending: false,
    }),
  },
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    settings: {
      invitations: {
        preview: { queryOptions: () => ({}) },
        accept: {
          mutationOptions: (options: { onSuccess: typeof fixture.onSuccess }) => {
            fixture.onSuccess = options.onSuccess;
            return options;
          },
        },
      },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      teamName: "Synthetic team",
      inviterName: "Synthetic operator",
      role: fixture.role,
      operationsProfile: fixture.operationsProfile,
      email: "v***@synthetic.invalid",
      prefillEmail: null,
      state: "valid",
    },
    isError: false,
    isPending: false,
  }),
  useMutation: () => ({ isError: false, isPending: false, mutate: vi.fn() }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.operationsProfile = true;
  fixture.role = "member";
  fixture.signedIn = false;
  fixture.onSuccess = null;
});

for (const [locale, messages] of [
  ["en", en],
  ["pt-BR", pt],
] as const) {
  function render() {
    return renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        timeZone: "UTC",
        messages: { settings: messages },
        // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
        children: createElement(AcceptInvitePage),
      }),
    );
  }

  describe(`operational invitation acceptance (${locale})`, () => {
    it("identifies the limited profile while keeping the address masked and scope private", () => {
      const html = render();
      expect(html).toContain(messages.invitations.accept.operationsRole);
      expect(html).toContain(messages.invitations.accept.operationsBody);
      expect(html).toContain("v***@synthetic.invalid");
      expect(html).not.toContain("viewer@synthetic.invalid");
      expect(html).not.toContain("domainIds");
      expect(html).not.toContain("sendMailboxIds");
      expect(html).not.toContain("&amp;email=");
    });

    it("opens the operational directory after accepting, without adding the team id to the URL", () => {
      fixture.signedIn = true;
      render();
      fixture.onSuccess?.({ teamId: "synthetic-team" });
      expect(fixture.push).toHaveBeenCalledExactlyOnceWith("/operations/users");
    });

    it.each(["member", "admin"] as const)(
      "preserves normal %s invitations and their destination",
      (role) => {
        fixture.operationsProfile = false;
        fixture.role = role;
        const html = render();
        expect(html).toContain(messages.members.roles[role]);
        expect(html).not.toContain(messages.invitations.accept.operationsBody);
        fixture.onSuccess?.({ teamId: "synthetic-team" });
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith("/emails");
      },
    );
  });
}
