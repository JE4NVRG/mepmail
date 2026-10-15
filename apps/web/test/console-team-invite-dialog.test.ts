import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enCommon from "../messages/en/common.json";
import enConsole from "../messages/en/console.json";
import enDomains from "../messages/en/domains.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptConsole from "../messages/pt-BR/console.json";
import ptDomains from "../messages/pt-BR/domains.json";

// The modal portals into document.body; inline, the dialog's body renders on the server.
vi.mock("@/components/modal", () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { "data-title": title }, children),
}));
// Any trpc path answers options objects; the queries return what each test sets.
let pendingRows: unknown[] | undefined = [];
const anyPath: unknown = new Proxy(() => ({}), {
  get: () => anyPath,
  apply: () => ({}),
});
vi.mock("@/lib/trpc", () => ({ useTRPC: () => anyPath }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: pendingRows }),
  useMutation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: undefined,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { InviteDialog, InviteReview, inviteErrorKey, looksLikeEmail } = await import(
  "@/components/console/teams/invite-dialog"
);
const { TeamDialog } = await import("@/components/console/teams/team-dialog");
const { teamMenuItems } = await import("@/components/console/team-actions");

type Locale = "en" | "pt-BR";
const MESSAGES = {
  en: { common: enCommon, console: enConsole, domains: enDomains },
  "pt-BR": { common: ptCommon, console: ptConsole, domains: ptDomains },
};

function render(locale: Locale, node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: MESSAGES[locale],
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: node,
    }),
  );
}

/** renderToStaticMarkup escapes apostrophes and quotes in text. */
const esc = (text: string) => text.replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

const TEAM = { id: "00000000-0000-4000-8000-0000000000a1", name: "Teste Free Planos" };

describe.each(["en", "pt-BR"] as const)("console invite (%s)", (locale) => {
  const dialog = MESSAGES[locale].console.teams.inviteDialog;

  it("opens on the address and the role, Member by default and no Owner", () => {
    pendingRows = [];
    const html = render(locale, createElement(InviteDialog, { team: TEAM, onClose: () => {} }));
    expect(html).toContain(dialog.title.replace("{team}", TEAM.name));
    expect(html).toContain(esc(dialog.lead));
    expect(html).toContain(dialog.roles.member);
    expect(html).toContain(esc(dialog.roleHint));
    expect(html).not.toContain(locale === "en" ? ">Owner<" : ">Proprietário<");
    // Nothing goes out from the first step: its button only leads to the review.
    expect(html).toContain(dialog.next);
    expect(html).not.toContain(dialog.confirm);
    expect(html).toContain(esc(dialog.pending.none));
  });

  it("reviews the team, the address and the role before anything is sent", () => {
    const html = render(
      locale,
      createElement(InviteReview, {
        teamName: TEAM.name,
        email: "admin@vultrix3d.com.br",
        role: "member",
      }),
    );
    expect(html).toContain(esc(dialog.reviewLead));
    expect(html).toContain(`<dd>${TEAM.name}</dd>`);
    expect(html).toContain("admin@vultrix3d.com.br");
    expect(html).toContain(`<dd>${dialog.roles.member}</dd>`);
    expect(html).toContain(esc(dialog.reviewNote));
  });

  it("lists pending invitations with Resend and Revoke", () => {
    pendingRows = [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        email: "pending@example.test",
        role: "admin",
        expiresAt: new Date(Date.now() + 86_400_000),
        sendCount: 1,
      },
    ];
    const html = render(locale, createElement(InviteDialog, { team: TEAM, onClose: () => {} }));
    expect(html).toContain("pending@example.test");
    expect(html).toContain(dialog.roles.admin);
    expect(html).toContain(dialog.pending.resend);
    expect(html).toContain(dialog.pending.revoke);
    pendingRows = [];
  });

  it("puts Invite member in the team dialog", () => {
    const html = render(
      locale,
      createElement(TeamDialog, {
        name: TEAM.name,
        detail: undefined,
        relayPending: null,
        onClose: () => {},
        onAdjustLimits: () => {},
        onInvite: () => {},
        onViewAsOwner: () => {},
        onSetRelay: () => {},
      }),
    );
    expect(html).toContain(MESSAGES[locale].console.teams.menu.invite);
  });
});

describe("console invite helpers", () => {
  it("offers Invite member in the team's … menu, right after Open team", () => {
    const inviteMember = vi.fn();
    const noop = () => {};
    const items = teamMenuItems(
      {
        id: TEAM.id,
        name: TEAM.name,
        plan: "free",
        planQuota: null,
        suspendedAt: null,
        broadcastsPausedByOperatorAt: null,
      },
      {
        openTeam: noop,
        inviteMember,
        adjustLimits: noop,
        changePlan: noop,
        pauseBroadcasts: noop,
        resumeBroadcasts: noop,
        suspend: noop,
        reinstate: noop,
        viewAsOwner: noop,
        dialogs: null,
      },
      (key) => key,
    );
    expect(items[1]?.label).toBe("invite");
    items[1]?.onSelect();
    expect(inviteMember).toHaveBeenCalledOnce();
  });

  it("names the refusals it can explain", () => {
    expect(inviteErrorKey(null)).toBeNull();
    expect(inviteErrorKey({ message: "Already invited.", data: { code: "CONFLICT" } })).toBe(
      "errors.conflict",
    );
    expect(inviteErrorKey({ message: "slow down", data: { code: "TOO_MANY_REQUESTS" } })).toBe(
      "errors.rate",
    );
    expect(inviteErrorKey({ message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(
      "errors.generic",
    );
    expect(looksLikeEmail(" admin@vultrix3d.com.br ")).toBe(true);
    expect(looksLikeEmail("admin@")).toBe(false);
  });
});
