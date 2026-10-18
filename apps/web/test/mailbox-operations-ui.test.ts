import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import {
  createElement,
  type ElementType,
  type FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes.json";
import pt from "../messages/pt-BR/mailboxes.json";

const fixture = {
  stateCursor: 0,
  seeds: {} as Record<number, unknown>,
  forms: [] as Array<{ onSubmit: (event: FormEvent) => Promise<void> }>,
  queries: [] as Array<{ enabled?: boolean }>,
  create: vi.fn(),
  update: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  changed: vi.fn(),
  close: vi.fn(),
  receiving: vi.fn(),
  invalidate: vi.fn(),
};

// The same AST extraction pattern as mailbox-client-actions.test.ts: exercise
// the production component and callbacks without importing browser-only TipTap.
type Ast = { type: string; start: number; end: number; [key: string]: unknown };
const require = createRequire(import.meta.url);
const workspaceRequire = createRequire(new URL("../../../package.json", import.meta.url));
const { transformSync } = createRequire(workspaceRequire.resolve("tsx/package.json"))(
  "esbuild",
) as {
  transformSync: (code: string, options: Record<string, unknown>) => { code: string };
};
const { parse } = require("next/dist/compiled/acorn") as {
  parse: (code: string, options: Record<string, unknown>) => Ast;
};
function nodes(value: unknown): Ast[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const item = value as Ast;
  return [item, ...Object.values(item).flatMap(nodes)].filter((node) => !!node.type);
}
const source = transformSync(
  readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailboxes-view.tsx", import.meta.url),
    "utf8",
  ),
  {
    loader: "tsx",
    jsx: "transform",
    jsxFactory: "__jsx",
    jsxFragment: "__Fragment",
    target: "es2022",
  },
).code;
const declarations = nodes(parse(source, { ecmaVersion: "latest", sourceType: "module" })).filter(
  (node) => node.type === "FunctionDeclaration" && (node.id as Ast)?.name === "RegistryDialog",
);
const declaration = declarations[0];
if (!declaration || declarations.length !== 1)
  throw new Error("Expected one production RegistryDialog");
const scope = {
  __Fragment: Fragment,
  useTranslations,
  useEffect,
  useRef,
  useState: (initial: unknown) => {
    const index = fixture.stateCursor++;
    return useState(Object.hasOwn(fixture.seeds, index) ? fixture.seeds[index] : initial);
  },
  useTRPC: () => ({
    mailboxes: Object.fromEntries(
      ["grants", "list", "create", "update", "grant", "revoke"].map((kind) => [
        kind,
        {
          queryOptions: (_input: unknown, options: object) => ({ kind, ...options }),
          queryKey: () => [kind],
          mutationOptions: () => ({ kind }),
        },
      ]),
    ),
  }),
  useQuery: (query: { enabled?: boolean }) => {
    fixture.queries.push(query);
    return { data: [], isSuccess: true, isPending: false, isError: false };
  },
  useMutation: ({ kind }: { kind: "create" | "update" | "grant" | "revoke" }) => ({
    isPending: false,
    mutateAsync: fixture[kind],
  }),
  useQueryClient: () => ({ invalidateQueries: fixture.invalidate }),
  styles: new Proxy({}, { get: (_target, key) => String(key) }),
  __jsx: (type: ElementType, props: Record<string, unknown>, ...children: ReactNode[]) => {
    if (type === "form") fixture.forms.push(props as (typeof fixture.forms)[number]);
    return createElement(type, props, ...children);
  },
  MailboxAliasesSection: () => createElement("span", null, "synthetic-alias-management"),
  MailboxDeletionSection: () => createElement("span", null, "synthetic-deletion-management"),
};
type RegistryProps = Parameters<
  typeof import("../src/app/(dashboard)/mailboxes/mailboxes-view")["RegistryDialog"]
>[0];
const RegistryDialog = new Function(
  ...Object.keys(scope),
  `"use strict"; return (${source.slice(declaration.start, declaration.end)});`,
)(...Object.values(scope)) as (props: RegistryProps) => ReactNode;

const contentSource = transformSync(
  readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
    "utf8",
  ),
  {
    loader: "tsx",
    jsx: "transform",
    jsxFactory: "__jsx",
    target: "es2022",
  },
).code;
const scheduleBranches = nodes(
  parse(contentSource, { ecmaVersion: "latest", sourceType: "module" }),
).filter((node) => {
  if (node.type !== "ConditionalExpression") return false;
  const call = node.consequent as Ast;
  if (call?.type !== "CallExpression") return false;
  const args = call.arguments as Ast[];
  return (
    args[0]?.name === "MailboxTimeMenu" &&
    nodes(args[1]).some(
      (property) =>
        property.type === "Property" &&
        (property.key as Ast)?.name === "kind" &&
        (property.value as Ast)?.value === "sendLater",
    )
  );
});
const scheduleBranch = scheduleBranches[0];
if (!scheduleBranch || scheduleBranches.length !== 1)
  throw new Error("Expected one production send-later menu gate");
const scheduleTest = scheduleBranch.test as Ast;
const showSendLater = new Function(
  "sendState",
  "isOwner",
  `return (${contentSource.slice(scheduleTest.start, scheduleTest.end)});`,
) as (sendState: string | null, isOwner: boolean) => boolean;
const ownershipDeclarations = nodes(
  parse(contentSource, { ecmaVersion: "latest", sourceType: "module" }),
).filter((node) => node.type === "VariableDeclarator" && (node.id as Ast)?.name === "isOwner");
const ownershipDeclaration = ownershipDeclarations[0];
if (!ownershipDeclaration || ownershipDeclarations.length !== 1)
  throw new Error("Expected one production mailbox ownership check");
const ownershipTest = ownershipDeclaration.init as Ast;
const mailboxOwner = new Function(
  "selectedBox",
  "currentUserId",
  `return (${contentSource.slice(ownershipTest.start, ownershipTest.end)});`,
) as (
  box: { ownerActive: boolean; ownerUserId: string } | undefined,
  currentUserId: string,
) => boolean;

const user = {
  id: "synthetic-operator",
  name: "Synthetic operator",
  email: "operator@synthetic.invalid",
};
const domain = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "allowed.synthetic.invalid",
  status: "verified" as const,
};
const box = {
  id: "22222222-2222-4222-8222-222222222222",
  address: "mail@allowed.synthetic.invalid",
  label: "Synthetic mailbox",
  domainId: domain.id,
  ownerUserId: "synthetic-other-owner",
  ownerActive: true,
  kind: "person" as const,
  status: "planned" as const,
  canRead: false,
  canDraft: false,
  canSend: false,
  origin: "hosted" as const,
  deleteAfter: null,
} as Parameters<typeof RegistryDialog>[0]["mailbox"];

beforeEach(() => {
  vi.clearAllMocks();
  fixture.stateCursor = 0;
  fixture.seeds = {};
  fixture.forms = [];
  fixture.queries = [];
  fixture.create.mockResolvedValue({ id: "synthetic-created" });
  fixture.grant.mockResolvedValue({ id: "synthetic-grant" });
});

describe("send-later ownership in the production UI", () => {
  it("does not offer scheduling to a delegated sender", () => {
    expect(showSendLater(null, false)).toBe(false);
    expect(showSendLater(null, true)).toBe(true);
    expect(showSendLater("requesting", true)).toBe(false);
  });
  it("derives ownership from the active mailbox without requiring a loaded message", () => {
    expect(mailboxOwner({ ownerActive: true, ownerUserId: "owner" }, "owner")).toBe(true);
    expect(mailboxOwner({ ownerActive: true, ownerUserId: "owner" }, "delegate")).toBe(false);
    expect(mailboxOwner({ ownerActive: false, ownerUserId: "owner" }, "owner")).toBe(false);
    expect(mailboxOwner(undefined, "owner")).toBe(false);
    expect(
      showSendLater(null, mailboxOwner({ ownerActive: true, ownerUserId: "owner" }, "owner")),
    ).toBe(true);
  });
});

for (const [locale, messages] of [
  ["en", en],
  ["pt-BR", pt],
] as const) {
  function render(
    canManage: boolean,
    mailbox = null as Parameters<typeof RegistryDialog>[0]["mailbox"],
  ) {
    fixture.stateCursor = 0;
    return renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale,
        timeZone: "UTC",
        messages: { mailboxes: messages },
        // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
        children: createElement(RegistryDialog, {
          mailbox,
          options: { domains: [domain], members: [user], currentUserId: user.id, canManage },
          close: fixture.close,
          changed: fixture.changed,
          openReceiving: fixture.receiving,
        }),
      }),
    );
  }

  describe(`operational mailbox creation (${locale})`, () => {
    it("offers only the scoped creation form without ownership, grants or billing controls", () => {
      const html = render(false);
      expect(html).toContain(domain.name);
      expect(html).toContain(messages.delegatedCreate.split(";")[0]);
      expect(html).not.toContain(messages.accessHint);
      expect(html).not.toContain('value="send"');
      expect(html).not.toContain("synthetic-deletion-management");
      expect(html).not.toContain("synthetic-alias-management");
      expect(html).not.toContain('href="/settings/billing');
      expect(fixture.queries[0]?.enabled).toBe(false);
      expect(fixture.forms).toHaveLength(1);
    });

    it("binds creation to the current user even if stale form state contains a different owner", async () => {
      fixture.seeds = { 1: "synthetic-outsider", 2: "Synthetic new mailbox", 3: "operator" };
      render(false);
      await fixture.forms[0]?.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent);
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith({
        domainId: domain.id,
        ownerUserId: user.id,
        label: "Synthetic new mailbox",
        localPart: "operator",
        kind: "person",
      });
      expect(fixture.changed).toHaveBeenCalledExactlyOnceWith("synthetic-created");
      expect(fixture.update).not.toHaveBeenCalled();
      expect(fixture.grant).not.toHaveBeenCalled();
      expect(fixture.revoke).not.toHaveBeenCalled();
    });

    it("lets an administrator explicitly select and grant read, draft and send", async () => {
      fixture.seeds = { 6: user.id, 7: "send" };
      const html = render(true, box);
      expect(html).toContain(messages.accessHint);
      expect(html).toContain('value="read"');
      expect(html).toContain('value="draft"');
      expect(html).toContain('value="send" selected=""');
      expect(html).toContain(messages.sendPermission);
      await fixture.forms[1]?.onSubmit({ preventDefault: vi.fn() } as unknown as FormEvent);
      expect(fixture.grant).toHaveBeenCalledExactlyOnceWith({
        mailboxId: box?.id,
        userId: user.id,
        permission: "send",
      });
      expect(fixture.create).not.toHaveBeenCalled();
    });
  });
}
