import { readFileSync } from "node:fs";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConsoleHeldMessageReviewPage from "@/app/console/safety/[teamId]/held/[emailId]/page";
import {
  HELD_REVIEW_COPY,
  HELD_REVIEW_QUERY_POLICY,
  HeldMessageReview,
  HeldMessageReviewEntry,
  HeldReviewContent,
  HeldReviewRequestDialog,
} from "@/components/console/safety/held-message-review";
import enCommon from "../messages/en/common.json";
import ptCommon from "../messages/pt-BR/common.json";

type Status = {
  enabled: boolean;
  message: { id: string; status: string; createdAt: Date } | null;
  access: { operationId: string; expiresAt: Date; state: "pending" | "ready" } | null;
};
const fixture = vi.hoisted(() => ({
  status: undefined as Status | undefined,
  failed: false,
  loading: false,
  mutate: vi.fn(),
  operator: true,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/server/console-gate", () => ({
  consoleOperator: async () => (fixture.operator ? { id: "operator" } : null),
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    console: {
      heldReview: {
        status: { queryOptions: () => ({ queryKey: ["held-status"] }) },
        requestAccess: { mutationOptions: () => ({}) },
      },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: fixture.status,
    isPending: fixture.loading,
    isError: fixture.failed,
    isFetching: false,
  }),
  useMutation: () => ({ mutate: fixture.mutate, isPending: false }),
}));
vi.mock("@/components/modal", () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) =>
    createElement("section", { role: "dialog", "aria-label": title }, children),
}));

const TEAM = "00000000-0000-4000-8000-000000000001";
const EMAIL = "00000000-0000-4000-8000-000000000002";
const EXPIRY = new Date("2099-10-16T18:00:00Z");
function render(children: ReactNode, locale: "en" | "pt-BR" = "pt-BR") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { common: locale === "pt-BR" ? ptCommon : enCommon },
      children,
    }),
  );
}
function screen(locale: "en" | "pt-BR" = "pt-BR") {
  return render(createElement(HeldMessageReview, { teamId: TEAM, emailId: EMAIL }), locale);
}

beforeEach(() => {
  fixture.status = {
    enabled: true,
    message: { id: EMAIL, status: "queued", createdAt: new Date("2026-10-16T12:00:00Z") },
    access: null,
  };
  fixture.failed = false;
  fixture.loading = false;
  fixture.operator = true;
  fixture.mutate.mockClear();
});

describe("held message review screen", () => {
  it("links the metadata-only entry card to exactly the configured team and held message", () => {
    const html = render(createElement(HeldMessageReviewEntry, { teamId: TEAM }));
    expect(html).toContain("Revisão de mensagem retida");
    expect(html).toContain("Revisar mensagem retida");
    expect(html).toContain(`href="/console/safety/${TEAM}/held/${EMAIL}"`);
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"[^>]*><h2 id="\1"/);
    expect(html).toContain("não libera nem envia e-mails");
    expect(html).not.toMatch(/<(button|form|textarea)\b/);
    expect(html).not.toContain("Liberar envio");
    expect(fixture.mutate).not.toHaveBeenCalled();
    const english = render(createElement(HeldMessageReviewEntry, { teamId: TEAM }), "en");
    expect(english).toContain("Held message review");
    expect(english).toContain("Review held message");
  });

  it("hides the entry card for errors, loading, disabled scope and absent messages", () => {
    const entry = () => render(createElement(HeldMessageReviewEntry, { teamId: TEAM }));
    fixture.failed = true;
    expect(entry()).toBe("");
    fixture.failed = false;
    fixture.loading = true;
    expect(entry()).toBe("");
    fixture.loading = false;
    fixture.status = {
      enabled: false,
      message: { id: EMAIL, status: "queued", createdAt: new Date() },
      access: null,
    };
    expect(entry()).toBe("");
    fixture.status = { enabled: true, message: null, access: null };
    expect(entry()).toBe("");
    fixture.status = undefined;
    expect(entry()).toBe("");
  });

  it("shows only held-message metadata and a review request, without requiring sent-message insights", () => {
    const html = screen();
    expect(html).toContain("Retida · não enviada");
    expect(html).toContain("Solicitar revisão desta mensagem");
    expect(html).toContain("A mensagem permanece retida");
    expect(html).not.toContain("Liberar envio");
    expect(html).not.toContain("Suspender");
    expect(html).not.toContain("Exportar");
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("refuses an unconfigured scope, absent message or different message id", () => {
    fixture.status = { enabled: false, message: null, access: null };
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].unavailable);
    expect(screen()).not.toContain(HELD_REVIEW_COPY["pt-BR"].request);
    fixture.status = { enabled: true, message: null, access: null };
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].missing);
    fixture.status.message = { id: "different", status: "queued", createdAt: new Date() };
    expect(screen()).not.toContain(HELD_REVIEW_COPY["pt-BR"].request);
    expect(screen()).not.toContain(HELD_REVIEW_COPY["pt-BR"].open);
  });

  it("keeps pending reviews explicit and opens only a ready, unexpired access", () => {
    if (!fixture.status) throw new Error("Missing status fixture");
    fixture.status.access = {
      operationId: "review-operation",
      expiresAt: EXPIRY,
      state: "pending",
    };
    expect(screen()).toContain("verifique a disponibilidade manualmente");
    expect(screen()).not.toContain(HELD_REVIEW_COPY["pt-BR"].open);
    fixture.status.access.state = "ready";
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].open);
    fixture.status.access.expiresAt = new Date("2020-01-01T00:00:00Z");
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].expired);
    expect(screen()).not.toContain(HELD_REVIEW_COPY["pt-BR"].open);
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].request);
  });

  it("announces failures and loading, and supports English without exposing server errors", () => {
    fixture.failed = true;
    expect(screen()).toContain('role="alert"');
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].failed);
    fixture.failed = false;
    fixture.loading = true;
    expect(screen()).toContain(HELD_REVIEW_COPY["pt-BR"].loading);
    fixture.loading = false;
    const html = screen("en");
    expect(html).toContain("Held · not sent");
    expect(html).toContain("Request review of this message");
    expect(html).not.toContain("Liberar envio");
  });

  it("connects the justification to its help and keeps submission disabled until justified", () => {
    const html = render(
      createElement(HeldReviewRequestDialog, {
        locale: "pt-BR",
        pending: false,
        error: true,
        onClose: () => {},
        onSubmit: () => {},
      }),
    );
    expect(html).toMatch(/<label for="([^"]+-why)">Justificativa<\/label>/);
    expect(html).toMatch(
      /<textarea[^>]*maxLength="1000"[^>]*required=""[^>]*aria-invalid="false"[^>]*aria-describedby="[^"]+-help"/,
    );
    expect(html).toContain("Não inclua credenciais");
    expect(html).toContain('role="alert"');
    expect(html).toContain(HELD_REVIEW_COPY["pt-BR"].requestFailed);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
    expect(html).not.toContain("auditoria da equipe em 7 dias");
  });

  it("renders message content and link domains as escaped text, with no active HTML or URLs", () => {
    const html = render(
      createElement(HeldReviewContent, {
        locale: "pt-BR",
        content: {
          subject: [{ text: "<script>example</script>" }],
          spans: [{ text: "https://example.test/action" }, { text: "[ocultado]", redacted: true }],
          expiresAt: EXPIRY,
          redactions: 1,
          linkHosts: ["example.test", '<img src="x">'],
        },
      }),
    );
    expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(html).toContain("https://example.test/action");
    expect(html).toContain('class="ms-redact"');
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<(a|script|iframe|img)\b/);
    expect(html).toContain(HELD_REVIEW_COPY["pt-BR"].noMonitor);
  });

  it("never automatically repeats a content view or persists it in browser storage", () => {
    expect(HELD_REVIEW_QUERY_POLICY).toMatchObject({
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      refetchInterval: false,
    });
    const source = readFileSync(
      new URL("../src/components/console/safety/held-message-review.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /console\.(teams|safety)\.|releaseSendReview|clearFlag|sendEmail|dangerouslySetInnerHTML|localStorage|sessionStorage/,
    );
  });

  it("checks the console operator before rendering the dedicated route", async () => {
    fixture.operator = false;
    await expect(
      ConsoleHeldMessageReviewPage({ params: Promise.resolve({ teamId: TEAM, emailId: EMAIL }) }),
    ).rejects.toThrow("NOT_FOUND");
    fixture.operator = true;
    const page = await ConsoleHeldMessageReviewPage({
      params: Promise.resolve({ teamId: TEAM, emailId: EMAIL }),
    });
    expect(page.type).toBe(HeldMessageReview);
    expect(page.props).toMatchObject({ teamId: TEAM, emailId: EMAIL });
  });
});
