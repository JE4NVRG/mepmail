import { readFileSync } from "node:fs";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement, type DialogHTMLAttributes, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes-activity.json";
import pt from "../messages/pt-BR/mailboxes-activity.json";
import { MailboxActivityDialog } from "../src/app/(dashboard)/mailboxes/mailbox-activity";

type Entry = {
  id: string;
  action:
    | "mailbox.items_listed"
    | "mailbox.item_read"
    | "mailbox.draft_saved"
    | "mailbox.send_approved";
  createdAt: Date;
  actor: { kind: "agent" | "person"; label: string | null };
  folder?: "inbox" | "drafts" | "sent";
  count?: number;
  revision?: number;
  itemId?: string;
};
type Page = { items: Entry[]; nextCursor: { createdAt: string; id: string } | null };
const fixture = vi.hoisted(() => ({
  query: {} as ReturnType<typeof querySnapshot>,
  options: {} as Record<string, unknown>,
  input: {} as Record<string, unknown>,
  dialog: {} as DialogHTMLAttributes<HTMLDialogElement>,
  buttons: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: Record<string, unknown>) => {
    fixture.options = options;
    return fixture.query;
  },
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    mailboxes: {
      activity: {
        infiniteQueryOptions: (
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => {
          fixture.input = input;
          return options;
        },
      },
    },
  }),
}));
vi.mock("react/jsx-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-runtime")>();
  const capture = (type: unknown, props: Record<string, unknown>) => {
    if (type === "dialog") fixture.dialog = props;
    if (type === "button") fixture.buttons.push(props);
  };
  return {
    ...runtime,
    jsx: (type: Parameters<typeof runtime.jsx>[0], props: Record<string, unknown>, key: string) => {
      capture(type, props);
      return runtime.jsx(type, props, key);
    },
    jsxs: (
      type: Parameters<typeof runtime.jsxs>[0],
      props: Record<string, unknown>,
      key: string,
    ) => {
      capture(type, props);
      return runtime.jsxs(type, props, key);
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = args;
      if (type === "dialog") fixture.dialog = props as DialogHTMLAttributes<HTMLDialogElement>;
      if (type === "button") fixture.buttons.push(props as Record<string, unknown>);
      return runtime.jsxDEV(...args);
    },
  };
});

const at = new Date("2026-10-05T12:00:00Z");
const mailbox = { id: "11111111-1111-4111-8111-111111111111", address: "agent@synthetic.invalid" };
const close = vi.fn();
function entry(extra: Partial<Entry> = {}): Entry {
  return {
    id: "event-one",
    action: "mailbox.items_listed",
    createdAt: at,
    actor: { kind: "agent", label: "Synthetic agent" },
    folder: "inbox",
    ...extra,
  };
}
function querySnapshot(pages: Page[] = []) {
  return {
    data: { pages },
    isPending: false,
    isError: false,
    isFetching: false,
    isRefetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: vi.fn(async () => ({ data: { pages } })),
    fetchNextPage: vi.fn(async () => ({ data: { pages } })),
  };
}
function render(locale: "en" | "pt-BR" = "pt-BR") {
  fixture.buttons = [];
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { "mailboxes-activity": locale === "en" ? en : pt },
      // biome-ignore lint/correctness/noChildrenProp: This provider's props require children for createElement type checking.
      children: createElement(MailboxActivityDialog, { mailbox, close }),
    }),
  );
}
function translator(locale: "en" | "pt-BR") {
  return createTranslator({
    locale,
    messages: { "mailboxes-activity": locale === "en" ? en : pt },
    namespace: "mailboxes-activity",
  });
}
function button(label: string) {
  const found = fixture.buttons.find((props) => props.children === label);
  expect(found).toBeDefined();
  return found!;
}
beforeEach(() => {
  close.mockClear();
  fixture.query = querySnapshot();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("mailbox activity real component SSR and explicit handlers", () => {
  for (const locale of ["en", "pt-BR"] as const) {
    it(`${locale}: has a truthful empty activation boundary and accessible native dialog labels`, () => {
      const t = translator(locale),
        html = render(locale);
      expect(html).toContain(t("historyStart"));
      expect(html).toContain(t("empty"));
      expect(html).toContain(t("privacy"));
      expect(html).toMatch(/<dialog[^>]*aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"/);
      expect(html).toContain('tabindex="-1"');
      expect(html).not.toContain(t("older"));
    });
    it(`${locale}: renders all authoritative actions and optional metadata without copying private content`, () => {
      const entries: Entry[] = [
        entry({ count: 0 }),
        entry({
          id: "event-read",
          action: "mailbox.item_read",
          actor: { kind: "agent", label: null },
        }),
        entry({ id: "event-draft", action: "mailbox.draft_saved", folder: "drafts", revision: 4 }),
        entry({
          id: "event-send",
          action: "mailbox.send_approved",
          folder: "sent",
          actor: { kind: "person", label: null },
          itemId: "private-item-id",
        }),
      ];
      Object.assign(entries[0]!, {
        body: "private-body-marker",
        subject: "private-subject-marker",
        recipient: "private-recipient@hidden.invalid",
        keyId: "private-key-marker",
      });
      fixture.query = querySnapshot([{ items: entries, nextCursor: null }]);
      const t = translator(locale),
        html = render(locale);
      for (const key of ["itemsListed", "itemRead", "draftSaved", "sendApproved"] as const)
        expect(html.replace(/&#x27;/g, "'")).toContain(t(`actions.${key}`));
      expect(html).toContain(t("messageCount", { count: 0 }));
      expect(html).toContain(t("revision", { revision: 4 }));
      expect(html).toContain(t("actors.person"));
      expect(html).toContain(t("actors.agent"));
      for (const value of [
        "private-body-marker",
        "private-subject-marker",
        "private-recipient@hidden.invalid",
        "private-key-marker",
        "private-item-id",
        "event-read",
      ])
        expect(html).not.toContain(value);
      expect(html).not.toMatch(/revoked|removed|revogado|removido/i);
      expect(html).toMatch(/<time datetime="2026-10-05T12:00:00\.000Z"/i);
    });
    it(`${locale}: loading and failed current access do not render stale activity`, () => {
      fixture.query.isPending = true;
      const t = translator(locale);
      expect(render(locale)).toContain(t("loading"));
      fixture.query = querySnapshot([
        {
          items: [entry({ actor: { kind: "agent", label: "Stale agent marker" } })],
          nextCursor: null,
        },
      ]);
      fixture.query.isError = true;
      const html = render(locale);
      expect(html).toContain(t("error"));
      expect(html).not.toContain("Stale agent marker");
      expect(html).not.toContain(t("empty"));
      expect(button(t("close")).disabled).not.toBe(true);
    });
    it(`${locale}: accumulated pages deduplicate event identity without changing their trusted order`, () => {
      const one = entry({ actor: { kind: "agent", label: "Newest event actor" } });
      const two = entry({ id: "event-two", actor: { kind: "person", label: "Older event actor" } });
      fixture.query = querySnapshot([
        { items: [one], nextCursor: { id: "page-two", createdAt: at.toISOString() } },
        { items: [one, two], nextCursor: null },
      ]);
      const html = render(locale),
        t = translator(locale);
      expect(html.match(/Newest event actor/g)).toHaveLength(1);
      expect(html.indexOf("Newest event actor")).toBeLessThan(html.indexOf("Older event actor"));
      expect(html).toContain(t("loadedCount", { count: 2 }));
    });
  }
  it("binds lazy history to the exact mailbox, 25 rows and explicit refresh with a public server cursor", () => {
    render();
    expect(fixture.input).toEqual({ mailboxId: mailbox.id, limit: 25 });
    expect(fixture.options).toMatchObject({
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
    const next = fixture.options.getNextPageParam as (page: Page) => Page["nextCursor"] | undefined;
    const cursor = { createdAt: at.toISOString(), id: "cursor-id" };
    expect(next({ items: [], nextCursor: cursor })).toBe(cursor);
    expect(next({ items: [], nextCursor: null })).toBeUndefined();
  });
  it("refreshes and fetches older pages only through explicit controls, with a duplicate-click guard", async () => {
    fixture.query = querySnapshot([
      { items: [entry()], nextCursor: { id: "cursor", createdAt: at.toISOString() } },
    ]);
    fixture.query.hasNextPage = true;
    let resolve: (value: { data: { pages: Page[] } }) => void = () => {};
    fixture.query.refetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render();
    (button(pt.refresh).onClick as () => void)();
    (button(pt.refresh).onClick as () => void)();
    expect(fixture.query.refetch).toHaveBeenCalledTimes(1);
    resolve({ data: { pages: [] } });
    await Promise.resolve();
    await Promise.resolve();
    (button(pt.older).onClick as () => void)();
    await Promise.resolve();
    expect(fixture.query.fetchNextPage).toHaveBeenCalledWith({ throwOnError: true });
  });
  it("keeps close and Escape available during in-flight fetches and closes a session only once", () => {
    fixture.query.isFetching = true;
    render();
    expect(button(pt.refresh).disabled).toBe(true);
    expect(button(pt.close).disabled).not.toBe(true);
    const preventDefault = vi.fn();
    fixture.dialog.onCancel?.({ preventDefault } as unknown as Parameters<
      NonNullable<typeof fixture.dialog.onCancel>
    >[0]);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    (button(pt.close).onClick as () => void)();
    fixture.dialog.onClose?.({} as Parameters<NonNullable<typeof fixture.dialog.onClose>>[0]);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("cycles Tab/Shift+Tab within the actual dialog handler without disabling native Escape", () => {
    render();
    const first = { getClientRects: () => [1], focus: vi.fn() };
    const last = { getClientRects: () => [1], focus: vi.fn() };
    const target = {
      querySelectorAll: () => [first, last],
      ownerDocument: { activeElement: last },
      contains: () => true,
    };
    const preventDefault = vi.fn();
    fixture.dialog.onKeyDown?.({
      key: "Tab",
      shiftKey: false,
      currentTarget: target,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLDialogElement>);
    expect(first.focus).toHaveBeenCalledTimes(1);
    target.ownerDocument.activeElement = first;
    fixture.dialog.onKeyDown?.({
      key: "Tab",
      shiftKey: true,
      currentTarget: target,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLDialogElement>);
    expect(last.focus).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
  it("escapes actor labels instead of interpreting markup", () => {
    fixture.query = querySnapshot([
      {
        items: [entry({ actor: { kind: "agent", label: "<script>private()</script>" } })],
        nextCursor: null,
      },
    ]);
    const html = render();
    expect(html).toContain("&lt;script&gt;private()&lt;/script&gt;");
    expect(html).not.toContain("<script>private()");
  });
  it("preserves the existing tokens, wrapping layout and 44px controls for 390px widths", () => {
    const css = readFileSync(
      new URL("../src/app/(dashboard)/mailboxes/mailbox-activity.module.css", import.meta.url),
      "utf8",
    );
    expect(css).not.toMatch(/#[a-f\d]{3,8}\b|font-family:\s*["']/i);
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("min-width: 44px");
    expect(css).toMatch(/@media \(max-width: 520px\)/);
  });
});
