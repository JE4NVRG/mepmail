import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en/mailboxes-external.json";
import pt from "../messages/pt-BR/mailboxes-external.json";
import { MailboxExternalStatus } from "../src/app/(dashboard)/mailboxes/mailbox-external-status";

/**
 * What the owner reads under an external mailbox must match what the worker does: an
 * account in error retries by itself (at nextSyncAt) and "Sincronizar agora" can try
 * sooner; only a refused password or sign-in waits for the person.
 */
const NOW = new Date("2026-10-14T10:00:00Z");
const fixture = vi.hoisted(() => ({ status: null as Record<string, unknown> | null }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: fixture.status, isPending: false, refetch: async () => undefined }),
  useMutation: () => ({ isPending: false, mutateAsync: async () => undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));
vi.mock("@/lib/trpc", () => {
  const leaf = { queryOptions: () => ({}), mutationOptions: () => ({}), queryKey: () => [] };
  return {
    useTRPC: () => ({
      mailboxExternal: { status: leaf, replacePassword: leaf, syncNow: leaf, disconnect: leaf },
      mailboxes: { list: leaf },
    }),
  };
});
vi.mock("@/components/toast", () => ({ toast: () => undefined }));

const messages = {
  en: { "mailboxes-external": en },
  "pt-BR": { "mailboxes-external": pt },
} as const;
function render(locale: keyof typeof messages) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messages[locale],
      timeZone: "UTC",
      now: NOW,
      // biome-ignore lint/correctness/noChildrenProp: NextIntlClientProvider requires a typed children property with createElement.
      children: createElement(MailboxExternalStatus, {
        mailboxId: "00000000-0000-4000-8000-000000000001",
        address: "ana@gmail.com",
      }),
    }),
  );
}
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
/** The "Sincronizar agora" button's opening tag. */
const syncButton = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";

const status = (over: Record<string, unknown>) => ({
  provider: "gmail",
  auth: "password",
  imapHost: "imap.gmail.com",
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  username: "ana@gmail.com",
  status: "active",
  lastError: null,
  lastSyncedAt: new Date(NOW.getTime() - 60_000),
  nextSyncAt: new Date(NOW.getTime() + 60_000),
  createdAt: new Date(NOW.getTime() - 86_400_000),
  ...over,
});

beforeEach(() => {
  fixture.status = status({});
});

describe("Contas externas: the status under the mailbox", () => {
  it("says an account in error retries by itself, when, and lets Sincronizar agora try sooner", () => {
    fixture.status = status({
      status: "error",
      lastError: "imap_network",
      nextSyncAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    const html = render("pt-BR");
    expect(text(html)).toContain("Tentamos de novo sozinhos em 15 minutos");
    expect(text(html)).toContain("sem precisar conectar de novo");
    expect(syncButton(html, pt.status.syncNow)).not.toContain("disabled");
    expect(text(render("en"))).toContain("We'll try again by ourselves in 15 minutes");
  });

  it("explains a storage pause: new mail stays at the provider, and it resumes by itself", () => {
    fixture.status = status({
      status: "error",
      lastError: "storage_full",
      nextSyncAt: new Date(NOW.getTime() + 15 * 60_000),
    });
    const visible = text(render("pt-BR"));
    expect(visible).toContain("a sincronização pausou");
    expect(visible).toContain("Os e-mails novos continuam no provedor");
    expect(visible).toContain("tentamos de novo sozinhos em 15 minutos");
  });

  it("keeps Sincronizar agora off when the provider refused the password (the person must act)", () => {
    fixture.status = status({ status: "auth_failed", lastError: "imap_login" });
    const html = render("pt-BR");
    expect(text(html)).toContain(pt.status.authFailed);
    expect(syncButton(html, pt.status.syncNow)).toContain("disabled");
  });
});
