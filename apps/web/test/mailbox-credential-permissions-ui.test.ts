import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  cursor: 0,
  refCursor: 0,
  update: vi.fn(),
  read: vi.fn(),
  invalidate: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  busy: vi.fn(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: Record<string, unknown>) =>
    key + (args ? `:${Object.values(args).join(",")}` : ""),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "permissions-test",
  useEffect: () => undefined,
  useRef: (value: unknown) => {
    const index = fixture.refCursor++;
    fixture.refs[index] ??= { current: value };
    return fixture.refs[index];
  },
  // Deterministic hook slots exercise actual component handlers, not browser hydration.
  useState: (initial: unknown) => {
    const index = fixture.cursor++;
    if (!(index in fixture.states))
      fixture.states[index] = typeof initial === "function" ? initial() : initial;
    return [
      fixture.states[index],
      (value: unknown) => {
        fixture.states[index] = typeof value === "function" ? value(fixture.states[index]) : value;
      },
    ];
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
  useQuery: () => ({ data: [], isPending: false, isError: false }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPCClient: () => ({
    mailboxes: {
      updateTeamAgentKey: { mutate: fixture.update },
      teamAgentKeys: { query: fixture.read },
      createTeamAgentKey: { mutate: fixture.create },
      createAgentKey: { mutate: fixture.create },
    },
  }),
  useTRPC: () => ({
    mailboxes: {
      teamAgentKeys: { queryKey: () => ["teamAgentKeys"] },
      agentKeys: { queryKey: () => ["agentKeys"] },
    },
    mailboxAgents: { overview: { queryKey: () => ["overview"] } },
  }),
}));

import {
  commonMailboxScopes,
  MailboxCredentialPermissionsForm,
  mailboxPermissionsConfirmed,
  mailboxSendChanges,
} from "../src/app/(dashboard)/mailboxes/mailbox-credential-permissions";
import { teamAgentKeyChanges } from "../src/lib/mailbox-team-agent-edit";

type Credential = Parameters<typeof MailboxCredentialPermissionsForm>[0]["credential"];
const box = (mailboxId: string, scopes: ("read" | "draft" | "send")[], revoked = false) => ({
  mailboxId,
  address: `${mailboxId}@mepmail.dev`,
  scopes,
  revoked,
  isDefault: mailboxId === "lucas",
});
const credential: Credential = {
  id: "existing-cursor-grant",
  label: "Cursor",
  oauthClientId: "cursor-client",
  version: "version-before",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  lastSentAt: null,
  scopes: ["read"],
  mailboxes: [
    box("lucas", ["read", "draft"]),
    box("clara", ["read"]),
    box("ethan", ["read", "draft", "send"]),
    box("other", ["read", "draft"]),
    box("old", ["read"], true),
  ],
};
let tree: ReactElement;
function paint(mailboxId?: string) {
  fixture.cursor = fixture.refCursor = 0;
  tree = MailboxCredentialPermissionsForm({
    credential,
    credentialId: credential.id,
    mailboxId,
    onClose: fixture.close,
    onBusyChange: fixture.busy,
  });
  return renderToStaticMarkup(tree);
}
function nodes(node: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...nodes(element.props.children)];
}
function toggle(address: string, checked: boolean) {
  const row = nodes(tree).find(
    (node) =>
      node.type === "input" &&
      node.props["aria-label"] === `perMailbox.sendLabel:${address}@mepmail.dev`,
  );
  expect(row).toBeDefined();
  (row!.props.onChange as (event: unknown) => void)({ target: { checked } });
}
function button(label: string) {
  const found = nodes(tree).find((node) => node.type === "button" && node.props.children === label);
  expect(found).toBeDefined();
  return found!;
}
function submit() {
  const form = nodes(tree).find((node) => node.type === "form")!;
  return (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
}
async function settle() {
  // onSubmit intentionally discards its promise, just as React does.
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function applied(changes: ReturnType<typeof mailboxSendChanges>): Credential {
  return {
    ...credential,
    version: "version-after",
    mailboxes: credential.mailboxes.map((row) => ({
      ...row,
      scopes: changes.find((change) => change.mailboxId === row.mailboxId)?.scopes ?? row.scopes,
    })),
  };
}
beforeEach(() => {
  fixture.states = [];
  fixture.refs = [];
  fixture.cursor = fixture.refCursor = 0;
  for (const fn of [
    fixture.update,
    fixture.read,
    fixture.invalidate,
    fixture.create,
    fixture.close,
    fixture.busy,
  ])
    fn.mockReset();
  fixture.update.mockResolvedValue({});
  fixture.invalidate.mockResolvedValue(undefined);
});

describe("existing OAuth/team credential permissions UI", () => {
  it("ends tree traversal at undefined leaves rather than restarting at the root", () => {
    paint();
    expect(nodes(undefined)).toEqual([]);
    expect(nodes([undefined, false, null])).toEqual([]);
  });
  it("labels each send checkbox by mailbox and preserves visible read/draft state", () => {
    const html = paint();
    expect(html).toContain('aria-labelledby="permissions-test-title"');
    expect(html).toContain("perMailbox.title:Cursor");
    expect(html).toContain("perMailbox.preserved:perMailbox.allowed,perMailbox.denied");
    expect(nodes(tree).filter((node) => node.type === "input")).toHaveLength(4);
    expect(html).not.toContain("old@mepmail.dev");
    expect(button("team.edit.save").props.disabled).toBe(true);
  });

  it("only submits changed rows with the existing credential/version, never a token or mailboxIds", async () => {
    paint();
    toggle("lucas", true);
    toggle("clara", true);
    paint();
    const changes = mailboxSendChanges(credential, { lucas: true, clara: true });
    fixture.read.mockResolvedValue([applied(changes)]);
    submit();
    await settle();
    expect(fixture.update).toHaveBeenCalledExactlyOnceWith({
      id: credential.id,
      expectedVersion: credential.version,
      mailboxScopes: [
        { mailboxId: "lucas", scopes: ["read", "draft", "send"] },
        { mailboxId: "clara", scopes: ["read", "send"] },
      ],
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(paint()).toContain("perMailbox.saved");
    expect(fixture.invalidate.mock.calls.map(([input]) => input.queryKey)).toEqual([
      ["overview"],
      ["teamAgentKeys"],
      ["agentKeys"],
    ]);
  });

  it("cancel discards local state without saving", () => {
    paint();
    toggle("lucas", true);
    paint();
    (button("team.edit.cancel").props.onClick as () => void)();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("filters a mailbox dialog to its row without changing the grant or unshown scopes", async () => {
    expect(paint("clara")).not.toContain("lucas@mepmail.dev");
    toggle("clara", true);
    paint("clara");
    fixture.read.mockResolvedValue([applied(mailboxSendChanges(credential, { clara: true }))]);
    submit();
    await settle();
    expect(fixture.update.mock.calls[0]![0].mailboxScopes).toEqual([
      { mailboxId: "clara", scopes: ["read", "send"] },
    ]);
    expect(paint("clara")).toContain("perMailbox.saved");
  });

  it("stays pending through readback, disables cancellation and ignores duplicate submissions", async () => {
    let done!: (keys: Credential[]) => void;
    fixture.read.mockImplementation(
      () =>
        new Promise<Credential[]>((resolve) => {
          done = resolve;
        }),
    );
    paint();
    toggle("lucas", true);
    paint();
    submit();
    await settle();
    expect(paint()).toContain('aria-busy="true"');
    expect(button("team.edit.cancel").props.disabled).toBe(true);
    expect(paint()).not.toContain("perMailbox.saved");
    submit();
    expect(fixture.update).toHaveBeenCalledOnce();
    done([applied(mailboxSendChanges(credential, { lucas: true }))]);
    await settle();
    expect(paint()).toContain("perMailbox.saved");
  });

  it("shows conflict recovery without replacing pending choices or automatically retrying", async () => {
    fixture.update.mockRejectedValue({ data: { code: "CONFLICT" } });
    paint();
    toggle("lucas", true);
    paint();
    submit();
    await settle();
    expect(paint()).toContain("perMailbox.conflict");
    expect(paint()).not.toContain("perMailbox.saved");
    expect(nodes(tree).find((node) => node.type === "input")!.props.checked).toBe(true);
    submit();
    expect(fixture.update).toHaveBeenCalledOnce();
    fixture.read.mockResolvedValue([{ ...credential, version: "concurrent-version" }]);
    (button("perMailbox.reload").props.onClick as () => void)();
    await settle();
    expect(paint()).not.toContain("perMailbox.conflict");
    expect(nodes(tree).find((node) => node.type === "input")!.props.checked).toBe(false);
  });

  it("does not announce success when an untouched mailbox was accidentally broadened", async () => {
    paint();
    toggle("lucas", true);
    paint();
    fixture.read.mockResolvedValue([
      applied(mailboxSendChanges(credential, { lucas: true, other: true })),
    ]);
    submit();
    await settle();
    expect(paint()).toContain("perMailbox.unconfirmed");
    expect(paint()).not.toContain("perMailbox.saved");
  });

  it("does not claim success when readback is unavailable", async () => {
    fixture.read.mockRejectedValue(new Error("offline"));
    paint();
    toggle("lucas", true);
    paint();
    submit();
    await settle();
    expect(paint()).toContain("perMailbox.unconfirmed");
    expect(paint()).not.toContain("perMailbox.saved");
  });

  it("untoggling a change sends nothing and clearing send retains read/draft exactly", () => {
    expect(mailboxSendChanges(credential, { lucas: false })).toEqual([]);
    expect(mailboxSendChanges(credential, { ethan: false })).toEqual([
      { mailboxId: "ethan", scopes: ["read", "draft"] },
    ]);
    expect(commonMailboxScopes(credential)).toEqual(["read"]);
  });

  it("rejects changed grant membership, default, OAuth client or unchanged version", () => {
    const changes = mailboxSendChanges(credential, { lucas: true });
    const after = applied(changes);
    expect(mailboxPermissionsConfirmed(credential, after, changes)).toBe(true);
    expect(
      mailboxPermissionsConfirmed(credential, { ...after, version: credential.version }, changes),
    ).toBe(false);
    expect(
      mailboxPermissionsConfirmed(credential, { ...after, oauthClientId: "other-client" }, changes),
    ).toBe(false);
    expect(
      mailboxPermissionsConfirmed(
        credential,
        { ...after, mailboxes: after.mailboxes.slice(1) },
        changes,
      ),
    ).toBe(false);
    expect(
      mailboxPermissionsConfirmed(
        credential,
        { ...after, mailboxes: after.mailboxes.map((row) => ({ ...row, isDefault: false })) },
        changes,
      ),
    ).toBe(false);
  });

  it("a metadata-only rename compares the intersection and does not flatten mixed permissions", () => {
    const common = commonMailboxScopes(credential);
    expect(
      teamAgentKeyChanges(
        { ...credential, scopes: common },
        {
          label: "Cursor renamed",
          mailboxIds: ["lucas", "clara", "ethan", "other"],
          scopes: common,
          defaultMailboxId: "lucas",
          expiry: "",
        },
      ),
    ).toEqual({ label: "Cursor renamed" });
  });
});
