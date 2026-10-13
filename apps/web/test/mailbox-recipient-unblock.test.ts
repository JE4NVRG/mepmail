import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import enBlocks from "../messages/en/mailboxes-blocks.json";
import ptBlocks from "../messages/pt-BR/mailboxes-blocks.json";

const state = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => state.status,
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    mailboxes: {
      recipientBlock: { queryOptions: () => ({}) },
      unblockRecipient: { mutationOptions: () => ({}) },
    },
  }),
}));

const { MailboxBlockedRecipients } = await import(
  "../src/app/(dashboard)/mailboxes/mailbox-recipient-unblock"
);

function render(locale: "en" | "pt-BR") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { "mailboxes-blocks": locale === "en" ? enBlocks : ptBlocks },
      // biome-ignore lint/correctness/noChildrenProp: createElement in a .ts test.
      children: createElement(MailboxBlockedRecipients, {
        addresses: ["ops@example.test"],
        onUnblocked: () => {},
      }),
    }),
  ).replace(/&#x27;/g, "'");
}

describe.each(["en", "pt-BR"] as const)("blocked recipient (%s)", (locale) => {
  const t = locale === "en" ? enBlocks : ptBlocks;
  beforeEach(() => {
    state.status = {};
  });

  it("offers Desbloquear for a hard bounce", () => {
    state.status = {
      isPending: false,
      isError: false,
      data: {
        address: "ops@example.test",
        blocked: true,
        reason: "hard_bounce",
        blockedAt: null,
      },
    };
    const html = render(locale);
    expect(html).toContain(t.bouncedUndated.replace("{address}", "ops@example.test"));
    expect(html).toContain(`>${t.unblock}<`);
  });

  it("never offers it for a complaint", () => {
    state.status = {
      isPending: false,
      isError: false,
      data: { address: "ops@example.test", blocked: true, reason: "complaint", blockedAt: null },
    };
    const html = render(locale);
    expect(html).toContain(t.complaint.replace("{address}", "ops@example.test"));
    expect(html).not.toContain(`>${t.unblock}<`);
  });

  it("says only an owner or admin can when the server refuses the lookup", () => {
    state.status = { isPending: false, isError: true, error: { data: { code: "FORBIDDEN" } } };
    const html = render(locale);
    expect(html).toContain(t.adminOnly.replace("{address}", "ops@example.test"));
    expect(html).not.toContain(`>${t.unblock}<`);
  });
});
