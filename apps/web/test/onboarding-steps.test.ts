import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOnboardingState, OnboardingSteps } from "@/app/onboarding/onboarding-steps";
import en from "../messages/en/onboarding.json";
import pt from "../messages/pt-BR/onboarding.json";

type Attempt = { id: string; to: string[]; latestStatus: string; createdAt: Date };
type Fixture = {
  hasKey: boolean;
  onboardingSender?: string | null;
  sendPending?: boolean;
  first?: Attempt;
  latest?: Attempt;
  delivered: number;
  deliveredEvent: boolean;
  verifiedDomain: boolean;
  metricsPending?: boolean;
  sendAccepted?: boolean;
  failedQuery?: "emails" | "latest" | "metrics" | "detail" | "keys";
};
const hooks = vi.hoisted(() => ({
  fixture: {} as Fixture,
  queries: [] as { queryKey: [string, Record<string, unknown>?]; enabled?: boolean }[],
  mutate: vi.fn(),
  invalidateQueries: vi.fn(),
  getToken: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/lib/trpc", () => {
  const endpoint = (path: string) => ({
    queryOptions: (input?: Record<string, unknown>) => ({ queryKey: [path, input] }),
    queryKey: () => [path],
    pathKey: () => [path],
    mutationOptions: (options: Record<string, unknown>) => ({ ...options, mutationPath: path }),
  });
  return {
    useTRPC: () => ({
      system: { awsReadiness: endpoint("aws"), features: endpoint("features") },
      apiKeys: { list: endpoint("keys"), create: endpoint("create") },
      domains: { list: endpoint("domains") },
      emails: { list: endpoint("emails"), get: endpoint("detail") },
      metrics: { window: endpoint("metrics") },
      onboarding: { sendFirstEmail: endpoint("send") },
    }),
  };
});
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: [string, Record<string, unknown>?]; enabled?: boolean }) => {
    hooks.queries.push(options);
    const [path, input] = options.queryKey;
    const f = hooks.fixture;
    let data: unknown;
    if (path === "aws") data = { credentialsConfigured: true };
    if (path === "features")
      data = {
        onboardingSender:
          f.onboardingSender === undefined ? "welcome@example.com" : f.onboardingSender,
      };
    if (path === "keys")
      data = f.hasKey ? [{ tokenPrefix: "ms_fixture", last4: "0001", createdAt: new Date(0) }] : [];
    if (path === "domains")
      data = f.verifiedDomain ? [{ name: "example.com", status: "verified" }] : [];
    if (path === "emails") {
      const email = input?.order === "desc" ? (f.latest ?? f.first) : f.first;
      data = { items: email ? [email] : [], total: f.latest ? 2 : f.first ? 1 : 0 };
    }
    if (path === "metrics") data = { allTimeDelivered: f.delivered };
    if (path === "detail") {
      const email = [f.first, f.latest].find((row) => row?.id === input?.id);
      data = email
        ? {
            ...email,
            from: "welcome@example.com",
            events: f.deliveredEvent
              ? [{ type: "delivered", occurredAt: new Date("2026-09-30T10:00:01Z") }]
              : [],
          }
        : undefined;
    }
    const query = path === "emails" && input?.order === "desc" ? "latest" : path;
    const isError = f.failedQuery === query;
    return {
      data: isError ? undefined : data,
      isPending: path === "metrics" && f.metricsPending === true,
      isError,
      refetch: hooks.refetch,
    };
  },
  useMutation: (options: { mutationPath: string }) => ({
    mutate: hooks.mutate,
    isPending: options.mutationPath === "send" && hooks.fixture.sendPending === true,
    isSuccess: options.mutationPath === "send" && hooks.fixture.sendAccepted === true,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: hooks.invalidateQueries }),
}));
vi.mock("@/components/turnstile", () => ({
  useTurnstile: () => ({ getToken: hooks.getToken, slot: null }),
}));
vi.mock("@/components/code-highlight", () => ({
  CodeHighlight: ({ code }: { code: string }) => createElement("code", null, code),
}));
vi.mock("@/components/copy-chip", () => ({ CopyGlyph: () => null }));
vi.mock("@/components/status-badge", () => ({
  StatusBadge: ({ status }: { status: string }) =>
    createElement("span", { "data-status": status }, status),
}));
vi.mock("@/components/delivered-odometer", () => ({
  DeliveredOdometer: ({ value }: { value: number }) =>
    createElement("output", { "data-delivered": value }, value),
}));

function attempt(id: string, latestStatus: string): Attempt {
  return {
    id,
    latestStatus,
    to: ["member@example.com"],
    createdAt: new Date("2026-09-30T10:00:00Z"),
  };
}

function render(locale: "en" | "pt-BR" = "en") {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { onboarding: locale === "en" ? en : pt },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(OnboardingSteps, {
        userEmail: "member@example.com",
        apiUrl: "https://api.example.com",
        showInstanceHint: false,
        turnstileSiteKey: null,
      }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.queries = [];
  hooks.fixture = { hasKey: true, delivered: 0, deliveredEvent: false, verifiedDomain: false };
});

describe("deriveOnboardingState", () => {
  it("does not equate an accepted send with a delivery", () => {
    expect(deriveOnboardingState({ hasEmail: false, allTimeDelivered: 0 })).toBe("no-send");
    for (const latestStatus of [
      "queued_quota",
      "queued",
      "sent",
      "delivery_delayed",
      "opened",
      "clicked",
    ]) {
      expect(deriveOnboardingState({ hasEmail: true, latestStatus, allTimeDelivered: 0 })).toBe(
        "in-flight",
      );
    }
  });

  it.each(["bounced", "failed", "suppressed", "complained", "canceled"])(
    "%s is terminal without a confirmed delivery",
    (latestStatus) => {
      expect(deriveOnboardingState({ hasEmail: true, latestStatus, allTimeDelivered: 0 })).toBe(
        "failed",
      );
      expect(deriveOnboardingState({ hasEmail: true, latestStatus, allTimeDelivered: 118 })).toBe(
        "delivered",
      );
    },
  );

  it("uses real delivery evidence even before counters catch up or after history retention", () => {
    expect(
      deriveOnboardingState({
        hasEmail: true,
        latestStatus: "sent",
        allTimeDelivered: 0,
        hasDeliveredEvent: true,
      }),
    ).toBe("delivered");
    expect(
      deriveOnboardingState({ hasEmail: true, latestStatus: "delivered", allTimeDelivered: 0 }),
    ).toBe("delivered");
    expect(deriveOnboardingState({ hasEmail: false, allTimeDelivered: 118 })).toBe("delivered");
  });
});

for (const [locale, copy] of [
  ["en", en],
  ["pt-BR", pt],
] as const) {
  describe(`OnboardingSteps (${locale})`, () => {
    it("keeps the translated HTML payload intact in the send snippet", () => {
      const html = render(locale);
      expect(html).toContain(copy.step2.html.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
      expect(html).not.toContain("onboarding.step2.html");
    });

    it("keeps key creation explicit when there is no key or send", () => {
      hooks.fixture.hasKey = false;
      const html = render(locale);
      expect(html).toContain(copy.step1.cta);
      expect(html).toContain(copy.step2.bodyLocked);
      expect(html).not.toContain("data-delivered=");
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("offers the platform demonstration without a key or domain and does not send on render", () => {
      hooks.fixture.hasKey = false;
      const html = render(locale);
      expect(html).toContain(copy.demo.title);
      expect(html).toContain(
        copy.demo.body
          .replace("{from}", "welcome@example.com")
          .replace("{to}", "member@example.com"),
      );
      const buttons = html.match(/<button[^>]*>.*?<\/button>/gs) ?? [];
      const sendButton = buttons.find((button) => button.includes(copy.demo.sendCta));
      expect(sendButton).toBeDefined();
      expect(sendButton).not.toContain("disabled=");
      expect(html).toContain(copy.step1.cta);
      const snippets = html.match(/<pre[^>]*>.*?<\/pre>/gs) ?? [];
      expect(snippets.join("")).toContain(copy.step2.fromPlaceholder);
      expect(snippets.join("")).not.toContain("welcome@example.com");
      expect(hooks.mutate).not.toHaveBeenCalled();
      expect(hooks.getToken).not.toHaveBeenCalled();
    });

    it("does not offer a platform demonstration when no sender is configured", () => {
      hooks.fixture.hasKey = false;
      hooks.fixture.onboardingSender = null;
      const html = render(locale);
      expect(html).not.toContain(copy.demo.title);
      expect(html).not.toContain(copy.demo.sendCta);
      expect(html).toContain(copy.step1.cta);
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("keeps the keyless demonstration disabled while its send is pending", () => {
      hooks.fixture.hasKey = false;
      hooks.fixture.sendPending = true;
      const html = render(locale);
      const buttons = html.match(/<button[^>]*>.*?<\/button>/gs) ?? [];
      const sendButton = buttons.find((button) => button.includes(copy.step2.sending));
      expect(sendButton).toContain('disabled=""');
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("keeps the keyless demonstration disabled until the delivery resolves", () => {
      hooks.fixture.hasKey = false;
      hooks.fixture.first = attempt("keyless-queued", "queued");
      const html = render(locale);
      const buttons = html.match(/<button[^>]*>.*?<\/button>/gs) ?? [];
      const sendButton = buttons.find((button) => button.includes(copy.attempt.waiting));
      expect(sendButton).toContain('disabled=""');
      expect(html).toContain('href="/emails/keyless-queued"');
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("uses the team's verified domain for the API snippet, not the platform sender", () => {
      hooks.fixture.verifiedDomain = true;
      const html = render(locale);
      const snippets = html.match(/<pre[^>]*>.*?<\/pre>/gs) ?? [];
      expect(snippets.join("")).toContain("onboarding@example.com");
      expect(snippets.join("")).not.toContain("welcome@example.com");
    });

    it("keeps the guide available with a key and no send", () => {
      const html = render(locale);
      expect(html).toContain(copy.demo.sendCta);
      expect(html).toContain(copy.step2.keyCommentReplace);
      expect(html).not.toContain("data-delivered=");
    });

    it.each(["queued_quota", "queued", "sent", "delivery_delayed"])(
      "%s remains in transit, keeps its log and is not success",
      (status) => {
        hooks.fixture.first = attempt("first", status);
        const html = render(locale);
        expect(html).toContain(copy.attempt.inFlight);
        expect(html).toContain('href="/emails/first"');
        expect(html).toContain(copy.step2.keyCommentReplace);
        expect(html).not.toContain("data-delivered=");
        expect(html).toMatch(
          /<button[^>]*disabled=""[^>]*>.*?Awaiting delivery|<button[^>]*disabled=""[^>]*>.*?Aguardando entrega/,
        );
      },
    );

    it("keeps a terminal failure visible with log, guidance and a manual retry", () => {
      hooks.fixture.first = attempt("first-bounce", "bounced");
      hooks.fixture.sendAccepted = true;
      const html = render(locale);
      expect(html).toContain('data-status="bounced"');
      expect(html).toContain(copy.attempt.failed);
      expect(html).toContain(copy.attempt.retryBody);
      expect(html).toContain(copy.attempt.retryCta);
      expect(html).toContain('href="/emails/first-bounce"');
      expect(html).not.toContain(copy.success.emailPending.split("{to}")[1]);
      expect(html).not.toContain(copy.step2.sentTo.replace("{to}", "member@example.com"));
      expect(html).not.toContain("data-delivered=");
    });

    it("shows confirmed progress while preserving the failed first attempt and both logs", () => {
      hooks.fixture.first = attempt("first-bounce", "bounced");
      hooks.fixture.latest = attempt("later-delivery", "delivered");
      hooks.fixture.delivered = 118;
      hooks.fixture.deliveredEvent = true;
      const html = render(locale);
      expect(html).toContain(copy.success.title);
      expect(html).toContain('data-delivered="118"');
      expect(html).toContain('data-status="bounced"');
      expect(html).toContain(copy.attempt.first);
      expect(html).toContain('href="/emails/first-bounce"');
      expect(html).toContain('href="/emails/later-delivery"');
      expect(html).toContain('href="/emails"');
      expect(html).not.toContain(copy.attempt.retryCta);
      expect(html).not.toContain(copy.success.emailPending.split("{to}")[1]);
    });

    it("follows the latest retry instead of treating the old bounce as current", () => {
      hooks.fixture.first = attempt("first-bounce", "bounced");
      hooks.fixture.latest = attempt("retry", "queued");
      const html = render(locale);
      expect(html).toContain(copy.attempt.inFlight);
      expect(html).toContain('data-status="bounced"');
      expect(html).toContain('href="/emails/retry"');
      expect(html).not.toContain(copy.attempt.retryBody);
      expect(html).not.toContain("data-delivered=");
    });

    it("recognizes a delivery event while the counter and current status lag", () => {
      hooks.fixture.first = attempt("event-confirmed", "sent");
      hooks.fixture.deliveredEvent = true;
      const html = render(locale);
      expect(html).toContain(copy.success.title);
      expect(html).toContain('data-delivered="1"');
      expect(html).not.toContain(copy.attempt.inFlight);
      expect(html).toContain('href="/emails/event-confirmed"');
    });

    it("preserves progress without an active key or retained email history", () => {
      hooks.fixture.hasKey = false;
      hooks.fixture.delivered = 118;
      const html = render(locale);
      expect(html).toContain(copy.success.title);
      expect(html).toContain('data-delivered="118"');
      expect(html).not.toContain(copy.success.keyAdded);
      expect(hooks.queries.find((q) => q.queryKey[0] === "metrics")?.enabled).not.toBe(false);
      expect(hooks.queries.find((q) => q.queryKey[0] === "emails")?.enabled).not.toBe(false);
    });

    it("reports a verified domain in current progress without changing it", () => {
      hooks.fixture.verifiedDomain = true;
      hooks.fixture.delivered = 1;
      const html = render(locale);
      expect(html).toContain(copy.success.domainVerified.replace("{domain}", "example.com"));
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("derives progress again on reload and a fresh team context", () => {
      hooks.fixture.first = attempt("team-a-bounce", "bounced");
      hooks.fixture.delivered = 118;
      const firstRender = render(locale);
      expect(render(locale)).toBe(firstRender);
      hooks.fixture = { hasKey: false, delivered: 0, deliveredEvent: false, verifiedDomain: false };
      const otherTeam = render(locale);
      expect(otherTeam).toContain(copy.step1.cta);
      expect(otherTeam).not.toContain("data-delivered=");
      expect(otherTeam).not.toContain("team-a-bounce");
      expect(hooks.mutate).not.toHaveBeenCalled();
    });

    it("waits for the delivery milestone query instead of flashing false progress", () => {
      hooks.fixture.first = attempt("first-bounce", "bounced");
      hooks.fixture.metricsPending = true;
      const html = render(locale);
      expect(html).not.toContain("data-delivered=");
      expect(html).not.toContain(copy.attempt.retryCta);
    });

    it.each(["emails", "latest", "metrics", "detail", "keys"] as const)(
      "an unavailable %s query never offers a new send or marks a failed delivery",
      (query) => {
        hooks.fixture.first = attempt("first-bounce", "bounced");
        hooks.fixture.latest = attempt("retry", "queued");
        hooks.fixture.failedQuery = query;
        const html = render(locale);
        expect(html).toContain(copy.attempt.readUnavailable);
        expect(html).toContain(copy.attempt.reload);
        expect(html).not.toContain(copy.attempt.failedTitle);
        expect(html).not.toContain(copy.attempt.retryCta);
        expect(html).not.toContain(copy.demo.sendCta);
        expect(html).not.toContain("data-delivered=");
        if (query !== "emails") expect(html).toContain('href="/emails/first-bounce"');
        expect(hooks.mutate).not.toHaveBeenCalled();
        expect(hooks.refetch).not.toHaveBeenCalled();
        delete hooks.fixture.failedQuery;
        expect(render(locale)).toContain(copy.attempt.inFlightTitle);
      },
    );

    it("never sends, creates keys or solves captcha during render", () => {
      hooks.fixture.first = attempt("first-bounce", "bounced");
      render(locale);
      expect(hooks.mutate).not.toHaveBeenCalled();
      expect(hooks.invalidateQueries).not.toHaveBeenCalled();
      expect(hooks.getToken).not.toHaveBeenCalled();
    });
  });
}
