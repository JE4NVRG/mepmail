import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQueryClient,
} from "@tanstack/react-query";
import { initTRPC } from "@trpc/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/*
 * Execute the production closures, rather than reproduce their algorithm in a
 * test helper. Importing the full view pulls browser-only TipTap/Next modules;
 * its rendered/browser journey is covered separately. The parser/transpiler
 * below are already shipped by Next and the workspace's tsx dependency.
 * Extraction is by AST identity, never a regex asserting implementation text.
 */
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
const source = transformSync(
  readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
    "utf8",
  ),
  { loader: "tsx", jsx: "transform", jsxFactory: "__jsx", target: "es2022" },
).code;
const tree = parse(source, { ecmaVersion: "latest", sourceType: "module" });

function nodes(value: unknown): Ast[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const item = value as Ast;
  return [item, ...Object.values(item).flatMap(nodes)].filter((node) => !!node.type);
}
function only(found: Ast[], label: string) {
  const node = found[0];
  if (found.length !== 1 || !node)
    throw new Error(`Expected one production ${label}, found ${found.length}`);
  return node;
}
function namedFunction(name: string) {
  return only(
    nodes(tree).filter(
      (node) => node.type === "FunctionDeclaration" && (node.id as Ast)?.name === name,
    ),
    name,
  );
}
function property(container: Ast, name: string) {
  return only(
    nodes(container).filter((node) => node.type === "Property" && (node.key as Ast)?.name === name),
    `${name} property`,
  ).value as Ast;
}
const dialogCall = only(
  nodes(tree).filter(
    (node) =>
      node.type === "CallExpression" &&
      ((node.arguments as Ast[])?.[0] as Ast)?.name === "DraftDialog",
  ),
  "DraftDialog JSX call",
);
const dialogProps = only(
  (dialogCall.arguments as Ast[]).filter((node) => node.type === "ObjectExpression"),
  "DraftDialog props",
);
const closures = {
  refresh: namedFunction("refresh"),
  submit: property(namedFunction("DraftDialog"), "onSubmit"),
  saved: property(dialogProps, "saved"),
  send: property(dialogProps, "send"),
};
function production<T extends (...args: never[]) => unknown>(
  name: keyof typeof closures,
  scope: Record<string, unknown>,
): T {
  const node = closures[name];
  return new Function(
    ...Object.keys(scope),
    `"use strict"; return (${source.slice(node.start, node.end)});`,
  )(...Object.values(scope)) as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function queryFixture(readItem = async () => ({ id: "draft-a", revision: 8 })) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  // This is the same real hook/context contract the view uses, without a DOM.
  let queries!: QueryClient;
  function Probe() {
    queries = useQueryClient();
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  const t = initTRPC.create();
  const itemsInput = z.object({
    mailboxId: z.string().nullable(),
    folder: z.string(),
    mailboxKind: z.string(),
    cursor: z.string().optional(),
  });
  const router = t.router({
    mailboxes: t.router({
      items: t.procedure.input(itemsInput).query(() => ({ items: [], nextCursor: null })),
      item: t.procedure.input(z.object({ mailboxId: z.string(), id: z.string() })).query(readItem),
      unreadCounts: t.procedure.query(() => ({ unread: 0 })),
      scheduling: t.router({ counts: t.procedure.query(() => ({ scheduled: 0 })) }),
      search: t.procedure
        .input(z.object({ query: z.string(), cursor: z.string().optional() }))
        .query(() => ({ items: [], nextCursor: null })),
    }),
    team: t.router({ list: t.procedure.query(() => []) }),
  });
  const trpc = createTRPCOptionsProxy({ router, ctx: {}, queryClient: queries });
  const refresh = production<() => Promise<void>>("refresh", { queries, trpc });
  return { queries, trpc, refresh };
}

type Saved = { mailboxId: string; id: string; revision: number };
const result: Saved = { mailboxId: "box-a", id: "draft-a", revision: 8 };
function dialogFixture(
  options: {
    save?: () => Promise<Saved>;
    refresh?: () => Promise<void>;
    navigateOnSave?: boolean;
    undoSendSeconds?: number;
  } = {},
) {
  const active = { current: true };
  const session = { current: "session-a" as string | null };
  const submitting = { current: false };
  const setError = vi.fn();
  const setSaving = vi.fn();
  const close = vi.fn();
  const lost = vi.fn();
  const setSearch = vi.fn();
  const events: string[] = [];
  const mutation = { mutateAsync: vi.fn(options.save ?? (async () => result)) };
  const draftSaved = vi.fn(() => {
    events.push("navigate");
    // Selecting Rascunhos changes the parent's key and cleans up DraftDialog.
    if (options.navigateOnSave !== false) active.current = false;
  });
  const saved = vi.fn(
    production<(value: Saved, sending: boolean) => Promise<void>>("saved", {
      refresh: options.refresh ?? (async () => {}),
      prefs: { undoSendSeconds: options.undoSendSeconds ?? 0 },
      composerSession: session,
      composer: { session: "session-a" },
      setSearch,
      draftSaved,
    }),
  );
  const submitRevision = vi.fn(async (_revision: unknown) => {
    events.push("queue");
  });
  const send = vi.fn(production<(value: Saved) => Promise<void>>("send", { submitRevision }));
  const focus = { current: { focus: vi.fn() } };
  const submit = production<(event: unknown) => Promise<void>>("submit", {
    submitting,
    loadingFiles: false,
    allowed: true,
    current: () => session.current === "session-a",
    canSend: true,
    showCc: false,
    cc: [],
    showBcc: false,
    bcc: [],
    to: ["recipient@example.invalid"],
    isRecipientAddress: () => true,
    recipientInput: focus,
    ccInput: focus,
    bccInput: focus,
    setError,
    setSaving,
    mutation,
    boxId: "box-a",
    source: { kind: "draft", id: "draft-a", revision: 7 },
    mode: "reply",
    subject: "Synthetic draft",
    text: "Keep this exact body",
    formatted: false,
    richHtml: null,
    retained: [],
    uploads: [],
    contacts: [],
    rememberRecipients: vi.fn(),
    active,
    saved,
    send,
    close,
    lost,
    t: (key: string) => key,
  });
  const event = (intent: "draft" | "send") => ({
    preventDefault: vi.fn(),
    nativeEvent: {
      submitter: { getAttribute: (name: string) => (name === "value" ? intent : null) },
    },
  });
  return {
    submit,
    event,
    mutation,
    saved,
    send,
    submitRevision,
    events,
    active,
    session,
    submitting,
    draftSaved,
    setSearch,
    setError,
    setSaving,
    close,
    lost,
  };
}

describe("mailbox client actions — production closures", () => {
  it("invalidates real tRPC infinite folders across mailboxes, plus detail/count/search, without touching team data", async () => {
    const { queries, trpc, refresh } = queryFixture();
    const keys = ["inbox", "drafts", "sent"].flatMap((folder) =>
      [null, "box-a"].map((mailboxId) => {
        const options = trpc.mailboxes.items.infiniteQueryOptions(
          { mailboxId, folder, mailboxKind: "person" },
          { getNextPageParam: (page) => page.nextCursor },
        );
        queries.setQueryData(options.queryKey, {
          pages: [{ items: [], nextCursor: null }],
          pageParams: [options.initialPageParam],
        });
        return options.queryKey;
      }),
    );
    const detail = trpc.mailboxes.item.queryKey({ mailboxId: "box-a", id: "draft-a" });
    const unread = trpc.mailboxes.unreadCounts.queryKey();
    const schedule = trpc.mailboxes.scheduling.counts.queryKey();
    const searchOptions = trpc.mailboxes.search.infiniteQueryOptions(
      { query: "Synthetic" },
      { getNextPageParam: (page) => page.nextCursor },
    );
    const search = searchOptions.queryKey;
    queries.setQueryData(detail, { id: "draft-a", revision: 7 });
    queries.setQueryData(unread, { unread: 0 });
    queries.setQueryData(schedule, { scheduled: 0 });
    queries.setQueryData(search, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [searchOptions.initialPageParam],
    });
    const unrelated = trpc.team.list.queryKey();
    queries.setQueryData(unrelated, []);
    await refresh();
    for (const key of [...keys, detail, unread, schedule, search]) {
      expect(queries.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    expect(queries.getQueryState(unrelated)?.isInvalidated).toBe(false);
  });

  it("finishes saving and navigates while an active real detail refetch is still pending", async () => {
    const gate = deferred<{ id: string; revision: number }>();
    const started = vi.fn(() => gate.promise);
    const { queries, trpc, refresh } = queryFixture(started);
    const options = trpc.mailboxes.item.queryOptions(
      { mailboxId: "box-a", id: "draft-a" },
      { staleTime: Infinity },
    );
    queries.setQueryData(options.queryKey, { id: "draft-a", revision: 7 });
    const observer = new QueryObserver(queries, options);
    const unsubscribe = observer.subscribe(() => {});
    let pending!: Promise<void>;
    const fixture = dialogFixture({ refresh: () => (pending = refresh()), navigateOnSave: false });
    let done = false;
    const save = fixture.submit(fixture.event("draft")).then(() => {
      done = true;
    });
    try {
      // Flush promise reactions only; no timeout or fake refetch implementation.
      await new Promise<void>((done) => setImmediate(done));
      expect(started).toHaveBeenCalledOnce();
      expect(fixture.draftSaved).toHaveBeenCalledWith(result);
      expect(done).toBe(true);
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.submitRevision).not.toHaveBeenCalled();
      expect(fixture.saved).toHaveBeenCalledExactlyOnceWith(result, false);
      expect(fixture.setSaving).toHaveBeenNthCalledWith(1, "draft");
      expect(fixture.setSaving).toHaveBeenLastCalledWith(null);
    } finally {
      gate.resolve({ id: "draft-a", revision: 8 });
      await pending;
      await save;
      unsubscribe();
    }
  });

  it("queues the revision returned by save before saved navigation can unmount the dialog", async () => {
    const fixture = dialogFixture();
    await fixture.submit(fixture.event("send"));
    expect(fixture.mutation.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "draft-a",
        expectedRevision: 7,
        text: "Keep this exact body",
      }),
    );
    expect(fixture.submitRevision).toHaveBeenCalledExactlyOnceWith({
      mailboxId: "box-a",
      id: "draft-a",
      expectedRevision: 8,
    });
    expect(fixture.events).toEqual(["queue", "navigate"]);
    expect(fixture.saved).toHaveBeenCalledExactlyOnceWith(result, true);
    expect(fixture.setSaving).toHaveBeenNthCalledWith(1, "send");
    expect(fixture.active.current).toBe(false);
  });

  it.each([
    { action: "save draft", sending: false, undoSendSeconds: 0, refreshes: 1 },
    { action: "send immediately", sending: true, undoSendSeconds: 0, refreshes: 0 },
    { action: "send with undo", sending: true, undoSendSeconds: 10, refreshes: 1 },
  ])("$action does $refreshes saved refetches", async ({ sending, undoSendSeconds, refreshes }) => {
    const refresh = vi.fn(async () => {});
    const fixture = dialogFixture({ refresh, undoSendSeconds });
    await fixture.saved(result, sending);
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(fixture.draftSaved).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("a double Send click while save is pending makes one save and one queue", async () => {
    const gate = deferred<Saved>();
    const fixture = dialogFixture({ save: () => gate.promise });
    const first = fixture.submit(fixture.event("send"));
    const second = fixture.submit(fixture.event("send"));
    expect(fixture.mutation.mutateAsync).toHaveBeenCalledOnce();
    gate.resolve(result);
    await Promise.all([first, second]);
    expect(fixture.submitRevision).toHaveBeenCalledExactlyOnceWith({
      mailboxId: "box-a",
      id: "draft-a",
      expectedRevision: 8,
    });
    expect(fixture.saved).toHaveBeenCalledOnce();
    expect(fixture.submitting.current).toBe(false);
  });

  it("does not queue or navigate when the composer session changed during save", async () => {
    const gate = deferred<Saved>();
    const fixture = dialogFixture({ save: () => gate.promise });
    const pending = fixture.submit(fixture.event("send"));
    fixture.session.current = "session-b";
    gate.resolve(result);
    await pending;
    expect(fixture.submitRevision).not.toHaveBeenCalled();
    expect(fixture.saved).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.submitting.current).toBe(false);
  });

  it.each(["CONFLICT", "FORBIDDEN"])(
    "preserves the %s save failure without queueing",
    async (code) => {
      const fixture = dialogFixture({
        save: async () => {
          throw { data: { code } };
        },
      });
      await fixture.submit(fixture.event("send"));
      expect(fixture.submitRevision).not.toHaveBeenCalled();
      expect(fixture.saved).not.toHaveBeenCalled();
      expect(fixture.close).not.toHaveBeenCalled();
      if (code === "CONFLICT") {
        expect(fixture.setError).toHaveBeenLastCalledWith("draftConflict");
        expect(fixture.lost).not.toHaveBeenCalled();
      } else {
        expect(fixture.lost).toHaveBeenCalledOnce();
      }
      expect(fixture.submitting.current).toBe(false);
      expect(fixture.setSaving).toHaveBeenLastCalledWith(null);
    },
  );
});
