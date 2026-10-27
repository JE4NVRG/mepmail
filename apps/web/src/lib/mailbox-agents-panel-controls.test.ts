import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en/mailboxes-agent.json";
import pt from "../../messages/pt-BR/mailboxes-agent.json";

type OverviewFixture = {
  activity: unknown[];
  approvals: {
    itemId: string;
    mailboxId: string;
    address: string;
    revision: number;
    agentLabel: string;
    requestedAt: string;
    subject: string;
    to: string[];
    cc: string[];
    bcc: string[];
    preview: string;
  }[];
  credentials: {
    credentialId: string;
    label: string;
    kind: string;
    scopes: string[];
    mailboxes: { mailboxId: string; address: string; scopes?: string[] }[];
    lastUsedAt: null;
    lastSentAt: null;
  }[];
};
type NodeProps = Record<string, unknown> & {
  children?: unknown;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
};
// Offline component/handler fixture, not an authenticated browser or server test.
const fixture = vi.hoisted(() => ({
  locale: "en",
  states: [] as unknown[],
  cursor: 0,
  mutations: [] as unknown[],
  invalidations: 0,
  pending: false,
  data: {} as OverviewFixture,
  refs: [] as { current: unknown }[],
  refCursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (load) => ({
  ...(await load<typeof import("react")>()),
  useId: () => "fixture",
  useRef: () => (fixture.refs[fixture.refCursor++] ??= { current: null }),
  useEffect: (effect: () => void) => {
    fixture.effects.push(effect);
  },
  useState: (initial: unknown) => {
    const slot = fixture.cursor++;
    if (!(slot in fixture.states)) fixture.states[slot] = initial;
    return [
      fixture.states[slot],
      (value: unknown) => {
        fixture.states[slot] = value;
      },
    ];
  },
}));
vi.mock("next-intl", async (load) => {
  const actual = await load<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => fixture.locale,
    useTranslations: (
      namespace: "mailboxes-agent" | "mailboxes-agent.panel" | "mailboxes-activity",
    ) =>
      actual.createTranslator({
        locale: fixture.locale,
        messages: {
          "mailboxes-agent": fixture.locale === "en" ? en : pt,
          "mailboxes-activity": { actors: { agent: "Agent" } },
        },
        namespace,
      }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    mailboxAgents: {
      overview: { queryOptions: () => ({}), queryKey: () => ["overview"] },
    },
    mailboxes: Object.fromEntries(
      ["queueDraft", "setTrash", "revokeAgentKey", "revokeTeamAgentKey"].map((name) => [
        name,
        { mutationOptions: () => ({ name }) },
      ]),
    ),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.data, isPending: false, isError: false }),
  useQueryClient: () => ({
    invalidateQueries: async () => {
      fixture.invalidations++;
    },
  }),
  useMutation: ({ name }: { name: string }) => ({
    isPending: fixture.pending,
    mutateAsync: async (input: unknown) => {
      fixture.mutations.push({ name, input });
    },
  }),
}));
vi.mock("../app/(dashboard)/mailboxes/mailbox-activity", () => ({
  ACTIVITY_ACTION_KEYS: {},
}));
vi.mock("../app/(dashboard)/mailboxes/mailbox-credential-permissions", () => ({
  MailboxCredentialPermissions: () => null,
}));
vi.mock("../app/(dashboard)/mailboxes/mailbox-recipient-unblock", () => ({
  MailboxBlockedRecipients: () => null,
}));

import { MailboxAgentsPanel } from "../app/(dashboard)/mailboxes/mailbox-agents-panel";

function tree() {
  fixture.cursor = 0;
  fixture.refCursor = 0;
  fixture.effects = [];
  return MailboxAgentsPanel({});
}
function nodes(node: unknown): ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<NodeProps>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function button(
  root: ReactElement,
  label: string,
): NodeProps & { onClick: () => void | Promise<void> } {
  const match = nodes(root).find((node) => node.type === "button" && node.props.children === label);
  if (!match || typeof match.props.onClick !== "function") {
    throw new Error(`Missing actionable button: ${label}`);
  }
  return { ...match.props, onClick: match.props.onClick };
}
function firstCredential() {
  const value = fixture.data.credentials[0];
  if (!value) throw new Error("Missing credential fixture");
  return value;
}
function firstApproval() {
  const value = fixture.data.approvals[0];
  if (!value) throw new Error("Missing approval fixture");
  return value;
}
function runEffect() {
  const effect = fixture.effects[0];
  if (!effect) throw new Error("Missing confirmation effect");
  effect();
}
beforeEach(() => {
  Object.assign(fixture, {
    locale: "en",
    states: [],
    cursor: 0,
    mutations: [],
    invalidations: 0,
    pending: false,
    refs: [],
    refCursor: 0,
    effects: [],
    data: {
      activity: [],
      approvals: [
        {
          itemId: "draft-1",
          mailboxId: "box-1",
          address: "support@example.test",
          revision: 7,
          agentLabel: "Support agent",
          requestedAt: "2026-10-27T12:00:00Z",
          subject: "Order update",
          to: ["to@example.test"],
          cc: ["cc@example.test"],
          bcc: ["private@example.test"],
          preview: "Review first",
        },
      ],
      credentials: [
        {
          credentialId: "credential-1",
          label: "Support agent",
          kind: "team",
          scopes: ["read"],
          mailboxes: [
            {
              mailboxId: "box-1",
              address: "support@example.test",
              scopes: ["read", "draft"],
            },
            {
              mailboxId: "box-2",
              address: "sales@example.test",
              scopes: ["read", "draft", "send"],
            },
          ],
          lastUsedAt: null,
          lastSentAt: null,
        },
      ],
    },
  });
});
describe("Correio agent control clarity and unchanged approval gates", () => {
  for (const locale of ["en", "pt-BR"])
    it(`renders existing ${locale} copy and per-mailbox permissions`, () => {
      fixture.locale = locale;
      const copy = locale === "en" ? en : pt;
      const html = renderToStaticMarkup(tree());
      expect(html).toContain(copy.panel.approvals.title);
      expect(html).toContain(copy.perMailbox.send);
      expect(html).toContain(copy.panel.agents.asksYou);
      expect(html).toContain(copy.panel.agents.scope.read);
      expect(html).toContain(copy.panel.agents.scope.draft);
      // Each mailbox row stays bound to its own permissions, including mixed grants.
      const root = tree();
      const rows = nodes(root).filter((n) => n.key === "box-1" || n.key === "box-2");
      expect(renderToStaticMarkup(rows[0])).not.toContain(copy.perMailbox.send);
      expect(renderToStaticMarkup(rows[1])).toContain(copy.perMailbox.send);
      expect(html).toContain("Support agent");
      expect(html).toContain("private@example.test");
    });
  it("does not send until a separate confirmation, preserving revision and mailbox", async () => {
    button(tree(), "Send").onClick();
    expect(fixture.mutations).toEqual([]);
    const confirm = tree();
    const group = nodes(confirm).find((n) => n.props?.["data-confirmation"] === true);
    if (!group) throw new Error("Missing confirmation region");
    expect(group.props.tabIndex).toBe(-1);
    expect(group.props["aria-labelledby"]).toContain("draft-1-mailbox");
    await button(confirm, "Send").onClick();
    expect(fixture.mutations).toEqual([
      {
        name: "queueDraft",
        input: { mailboxId: "box-1", id: "draft-1", expectedRevision: 7 },
      },
    ]);
    expect(fixture.invalidations).toBe(1);
  });
  it("keeps discard behind confirmation with exact trash payload", async () => {
    button(tree(), "Discard").onClick();
    expect(fixture.mutations).toEqual([]);
    await button(tree(), "Discard").onClick();
    expect(fixture.mutations).toEqual([
      {
        name: "setTrash",
        input: {
          mailboxId: "box-1",
          id: "draft-1",
          expectedRevision: 7,
          trashed: true,
        },
      },
    ]);
  });
  it("names revocation and preserves whole-credential confirmation", async () => {
    const revoke = button(tree(), "Revoke");
    expect(revoke["aria-label"]).toBe("Revoke key Support agent");
    expect(revoke["aria-describedby"]).toContain("credential-1-mailboxes");
    revoke.onClick();
    expect(fixture.mutations).toEqual([]);
    await button(tree(), "Revoke").onClick();
    expect(fixture.mutations).toEqual([
      { name: "revokeTeamAgentKey", input: { id: "credential-1" } },
    ]);
  });
  it("preserves mailbox-only revocation and the caller connect action", async () => {
    firstCredential().kind = "mailbox";
    firstCredential().mailboxes = [{ mailboxId: "box-1", address: "support@example.test" }];
    const connect = vi.fn();
    fixture.cursor = 0;
    fixture.refCursor = 0;
    button(MailboxAgentsPanel({ onConnect: connect }), "Connect an agent").onClick();
    expect(connect).toHaveBeenCalledOnce();
    button(tree(), "Revoke").onClick();
    expect(fixture.mutations).toEqual([]);
    await button(tree(), "Revoke").onClick();
    expect(fixture.mutations).toEqual([
      {
        name: "revokeAgentKey",
        input: { mailboxId: "box-1", id: "credential-1" },
      },
    ]);
  });
  it("disables sending without recipients and blocks all mutations while busy", () => {
    Object.assign(firstApproval(), { to: [], cc: [], bcc: [] });
    expect(button(tree(), "Send").disabled).toBe(true);
    fixture.pending = true;
    const root = tree();
    expect(button(root, "Send").disabled).toBe(true);
    expect(button(root, "Discard").disabled).toBe(true);
    expect(button(root, "Revoke").disabled).toBe(true);
  });
  it("Escape cancels only an idle confirmation, without mutations", () => {
    button(tree(), "Send").onClick();
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    fixture.pending = true;
    tree().props.onKeyDown(event);
    expect(fixture.states[0]).toBe("approve:draft-1");
    fixture.pending = false;
    tree().props.onKeyDown(event);
    expect(fixture.states[0]).toBe(null);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.mutations).toEqual([]);
  });
  it("never implies approval access for read-only or incomplete grouped grants", () => {
    firstCredential().mailboxes = [
      { mailboxId: "read", address: "read@example.test", scopes: ["read"] },
      { mailboxId: "missing", address: "missing@example.test" },
    ];
    const html = renderToStaticMarkup(tree());
    expect(html).not.toContain(en.panel.agents.asksYou);
    expect(html).not.toContain(en.perMailbox.send);
  });
  it("focuses an inline confirmation and returns to its exact opener after Escape", () => {
    const initial = tree();
    const confirmation = { focus: vi.fn() };
    const opener = {
      dataset: { confirmAction: "approve:draft-1" },
      focus: vi.fn(),
    };
    (initial.props as { ref: { current: unknown } }).ref.current = {
      querySelector: () => confirmation,
      querySelectorAll: () => [opener],
    };
    runEffect();
    button(initial, "Send").onClick();
    const active = tree();
    runEffect();
    expect(confirmation.focus).toHaveBeenCalledOnce();
    active.props.onKeyDown({
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    tree();
    runEffect();
    expect(opener.focus).toHaveBeenCalledOnce();
  });
  it("all module classes exist; focus and touch rules stay scoped", () => {
    const component = readFileSync(
      new URL("../app/(dashboard)/mailboxes/mailbox-agents-panel.tsx", import.meta.url),
      "utf8",
    );
    const css = readFileSync(
      new URL("../app/(dashboard)/mailboxes/mailbox-agents-panel.module.css", import.meta.url),
      "utf8",
    );
    for (const match of component.matchAll(/own\.(\w+)/g))
      expect(css).toMatch(new RegExp(`\\.${match[1]}\\b`));
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("button:focus-visible");
  });
});
