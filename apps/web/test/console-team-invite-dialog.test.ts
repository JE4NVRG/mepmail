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
// The pending-list query as the dialog reads it; a test may turn it into a failure.
let listQuery: Record<string, unknown> | null = null;
const refetch = vi.fn();
const anyPath: unknown = new Proxy(() => ({}), {
  get: () => anyPath,
  apply: () => ({}),
});
vi.mock("@/lib/trpc", () => ({ useTRPC: () => anyPath }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () =>
    listQuery ?? {
      data: pendingRows,
      isError: false,
      isPending: pendingRows === undefined,
      isFetching: false,
      refetch,
    },
  useMutation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: undefined,
    error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const {
  InviteDialog,
  InviteReview,
  PendingListError,
  inviteErrorKey,
  looksLikeEmail,
  pendingListState,
} = await import("@/components/console/teams/invite-dialog");
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

describe.each(["en", "pt-BR"] as const)("console invite pending list (%s)", (locale) => {
  const pending = MESSAGES[locale].console.teams.inviteDialog.pending;
  const dialog = () =>
    render(locale, createElement(InviteDialog, { team: TEAM, onClose: () => {} }));

  it("says the list failed, with Try again, instead of loading forever", () => {
    listQuery = { data: undefined, isError: true, isPending: false, isFetching: false, refetch };
    const html = dialog();
    expect(html).toContain(esc(pending.loadError));
    expect(html).toContain(pending.retry);
    expect(html).not.toContain(pending.loading);
    expect(html).not.toContain(pending.none);
    listQuery = null;
  });

  it("shows loading only on the first fetch, and an empty list as empty", () => {
    listQuery = { data: undefined, isError: false, isPending: true, isFetching: true, refetch };
    expect(dialog()).toContain(pending.loading);
    listQuery = { data: [], isError: false, isPending: false, isFetching: false, refetch };
    const empty = dialog();
    expect(empty).toContain(pending.none);
    expect(empty).not.toContain(pending.loading);
    listQuery = null;
  });

  it("recovers: after Try again the rows come back", () => {
    listQuery = { data: undefined, isError: true, isPending: false, isFetching: true, refetch };
    // While the retry runs, the button waits.
    expect(dialog()).toMatch(
      /<button[^>]*disabled[^>]*>.*Try again|<button[^>]*disabled[^>]*>.*Tentar novamente/,
    );
    listQuery = {
      data: [
        {
          id: "00000000-0000-4000-8000-0000000000c1",
          email: "back@example.test",
          role: "member",
          expiresAt: new Date(Date.now() + 86_400_000),
          sendCount: 1,
        },
      ],
      isError: false,
      isPending: false,
      isFetching: false,
      refetch,
    };
    const html = dialog();
    expect(html).toContain("back@example.test");
    expect(html).not.toContain(esc(pending.loadError));
    listQuery = null;
  });
});

describe("pending list states and Try again", () => {
  it("tells loading, failure, empty and ready apart, failure first", () => {
    expect(pendingListState({ data: undefined, isError: false, isPending: true })).toBe("loading");
    expect(pendingListState({ data: undefined, isError: true, isPending: false })).toBe("error");
    // A failed refetch is a failure even with old rows in the cache.
    expect(pendingListState({ data: [{}], isError: true, isPending: false })).toBe("error");
    expect(pendingListState({ data: [], isError: false, isPending: false })).toBe("empty");
    expect(pendingListState({ data: [{}], isError: false, isPending: false })).toBe("ready");
  });

  it("Try again calls the query's refetch", () => {
    const onRetry = vi.fn();
    const element = PendingListError({
      message: "failed",
      retryLabel: "Try again",
      retrying: false,
      onRetry,
    });
    const children = (element.props as { children: ReturnType<typeof createElement>[] }).children;
    const button = children.find((child) => child?.type === "button");
    if (!button) throw new Error("no Try again button");
    (button.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
