import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enConsole from "../messages/en/console.json";
import ptConsole from "../messages/pt-BR/console.json";

vi.mock("@/lib/trpc", () => ({ useTRPC: vi.fn() }));

const { InviteReview, OperationsScopeSelector, selectedOperationsScope } = await import(
  "@/components/console/teams/invite-dialog"
);

const choices = {
  domains: [
    { id: "fullcommerce", name: "fullcommerce360.com" },
    { id: "mepmail", name: "mepmail.dev" },
  ],
  mailboxes: [
    { id: "yuri", address: "yuri@fullcommerce360.com", label: "Yuri", domainId: "fullcommerce" },
    { id: "support", address: "suporte@mepmail.dev", label: "Suporte", domainId: "mepmail" },
    {
      id: "personal",
      address: "personal@fullcommerce360.com",
      label: "Personal",
      domainId: "fullcommerce",
    },
  ],
};

type Locale = "en" | "pt-BR";
const messages = { en: enConsole, "pt-BR": ptConsole };
function render(locale: Locale, node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { console: messages[locale] },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: node,
    }),
  );
}

describe("operational invitation selection", () => {
  it("starts without scope and never treats an unselected mailbox as granted", () => {
    expect(selectedOperationsScope(choices, [], []).valid).toBe(false);
    expect(selectedOperationsScope(choices, ["fullcommerce"], []).valid).toBe(false);
    const scope = selectedOperationsScope(choices, ["fullcommerce"], ["yuri"]);
    expect(scope.valid).toBe(true);
    expect(scope.domains.map((domain) => domain.id)).toEqual(["fullcommerce"]);
    expect(scope.mailboxes.map((mailbox) => mailbox.id)).toEqual(["yuri"]);
  });

  it("refuses stale ids and mailboxes outside the explicitly selected domains", () => {
    expect(selectedOperationsScope(undefined, ["fullcommerce"], ["yuri"]).valid).toBe(false);
    expect(selectedOperationsScope(choices, ["missing"], ["yuri"]).valid).toBe(false);
    expect(selectedOperationsScope(choices, ["fullcommerce"], ["missing"]).valid).toBe(false);
    expect(selectedOperationsScope(choices, ["fullcommerce"], ["support"]).valid).toBe(false);
    const partial = selectedOperationsScope(choices, ["fullcommerce"], ["yuri", "missing"]);
    expect(partial.valid).toBe(false);
    expect(partial.mailboxes.map((mailbox) => mailbox.id)).toEqual(["yuri"]);
    const external = {
      ...choices,
      mailboxes: [{ id: "external", address: "personal@example.test", label: "External", domainId: null }],
    };
    expect(selectedOperationsScope(external, ["fullcommerce"], ["external"]).valid).toBe(false);
  });
});

describe.each(["en", "pt-BR"] as const)("operational invitation UI (%s)", (locale) => {
  const t = messages[locale].teams.inviteDialog;
  const selectorProps = {
    options: choices,
    domainIds: [] as string[],
    mailboxIds: [] as string[],
    loading: false,
    error: false,
    retrying: false,
    onRetry: vi.fn(),
    onDomainChange: vi.fn(),
    onMailboxChange: vi.fn(),
  };

  it("presents labeled checkboxes with no default selections and reveals boxes by chosen domain", () => {
    const empty = render(locale, createElement(OperationsScopeSelector, selectorProps));
    expect(empty).toContain(`<legend class="ms-microlabel">${t.operations.domains}</legend>`);
    expect(empty).toContain("fullcommerce360.com");
    expect(empty).toContain("mepmail.dev");
    expect(empty).not.toContain("checked=");
    expect(empty).not.toContain("yuri@fullcommerce360.com");
    expect(empty).toContain(t.operations.noMailboxes);
    const selected = render(
      locale,
      createElement(OperationsScopeSelector, {
        ...selectorProps,
        domainIds: ["fullcommerce"],
        mailboxIds: ["yuri"],
      }),
    );
    expect(selected.match(/checked=""/g)).toHaveLength(2);
    expect(selected).toContain("yuri@fullcommerce360.com");
    expect(selected).not.toContain("suporte@mepmail.dev");
    expect(selected).toMatch(/<label[^>]*><input type="checkbox"[^>]*\/><span/);
  });

  it("reviews the exact address, read-only users, creation domains and allowed mailboxes", () => {
    const operations = selectedOperationsScope(
      choices,
      ["fullcommerce", "mepmail"],
      ["yuri", "support"],
    );
    const html = render(
      locale,
      createElement(InviteReview, {
        teamName: "FullCommerce360",
        email: "invitee@example.test",
        role: "operations",
        operations,
      }),
    );
    expect(html).toContain("invitee@example.test");
    expect(html).toContain(t.roles.operations);
    expect(html).toContain(t.operations.readOnly);
    expect(html).toContain(t.operations.mailboxAccess);
    expect(html).toContain("fullcommerce360.com");
    expect(html).toContain("mepmail.dev");
    expect(html).toContain("yuri@fullcommerce360.com");
    expect(html).toContain("suporte@mepmail.dev");
    expect(html).not.toContain("personal@fullcommerce360.com");
    expect(html).toContain(t.operations.exclusions);
    expect(html).toContain(t.operations.reviewPending);
  });

  it("distinguishes loading, failure and unavailable scope without presenting cached choices", () => {
    const loading = render(
      locale,
      createElement(OperationsScopeSelector, { ...selectorProps, loading: true }),
    );
    expect(loading).toContain(t.operations.loading);
    expect(loading).not.toContain('type="checkbox"');
    const failed = render(
      locale,
      createElement(OperationsScopeSelector, { ...selectorProps, error: true }),
    );
    expect(failed).toContain(t.operations.loadError);
    expect(failed).toContain(t.operations.retry);
    expect(failed).not.toContain('type="checkbox"');
    const unavailable = render(
      locale,
      createElement(OperationsScopeSelector, {
        ...selectorProps,
        options: { domains: [], mailboxes: [] },
      }),
    );
    expect(unavailable).toContain(t.operations.noDomains);
    expect(unavailable).toContain(t.operations.noMailboxes);
  });
});
