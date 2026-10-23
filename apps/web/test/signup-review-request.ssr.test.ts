import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SignupRiskQueue } from "@/components/console/safety/signup-risk-queue";
import { SignupReviewRequest } from "@/components/signup-review-request";
import en from "../messages/en/console.json";
import pt from "../messages/pt-BR/console.json";

const fixture = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  isError: false,
  isPending: false,
}));
const anyPath: unknown = new Proxy(() => ({}), { get: () => anyPath, apply: () => ({}) });
vi.mock("@/lib/trpc", () => ({ useTRPC: () => anyPath }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ ...fixture, refetch: vi.fn() }),
  useMutation: () => ({ isPending: false, isSuccess: false }),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));

beforeEach(() => {
  fixture.data = {};
  fixture.isError = false;
  fixture.isPending = false;
});
function render(
  locale: "en" | "pt-BR",
  component: typeof SignupRiskQueue | typeof SignupReviewRequest,
) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: { console: locale === "en" ? en : pt },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(component),
    }),
  );
}

it.each(["en", "pt-BR"] as const)(
  "shows an accessible request button and a receipt without context (%s)",
  (locale) => {
    const button = render(locale, SignupReviewRequest);
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain((locale === "en" ? en : pt).banner.reviewRequest.button);
    fixture.data = { pending: true, context: "PRIVATE-CONTEXT-MUST-NOT-RENDER" };
    const receipt = render(locale, SignupReviewRequest);
    expect(receipt).toContain('role="status"');
    expect(receipt).not.toContain("PRIVATE-CONTEXT-MUST-NOT-RENDER");
    expect(receipt).not.toContain("<form");
  },
);

it.each(["en", "pt-BR"] as const)(
  "queue distinguishes legacy holds, stored sandbox and effective access (%s)",
  (locale) => {
    fixture.data = {
      items: [
        {
          teamId: "legacy",
          name: "Legacy team",
          level: null,
          restriction: "held",
          reasons: [],
          paid: false,
          since: null,
        },
        {
          teamId: "sandbox",
          name: "Commercial team",
          level: "sandbox",
          restriction: "none",
          reasons: ["unknown_domain_age"],
          paid: true,
          since: null,
          reviewRequestedAt: new Date(),
        },
      ],
      total: 2,
      nextOffset: null,
    };
    const html = render(locale, SignupRiskQueue);
    const labels = locale === "en" ? en : pt;
    expect(html).toContain(labels.signupRisk.legacy);
    expect(html).toContain(labels.signupRisk.effectiveLevels.held);
    expect(html).toContain(labels.signupRisk.levels.sandbox);
    expect(html).toContain(labels.signupRisk.effectiveLevels.none);
    expect(html).toContain(labels.signupRisk.queue.paid);
    expect(html).toContain("unknown_domain_age");
    expect(html).toContain('href="/console/safety/legacy"');
  },
);

it("queue load failure exposes retry without reporting an invented count", () => {
  fixture.isError = true;
  const html = render("en", SignupRiskQueue);
  expect(html).toContain('role="alert"');
  expect(html).toContain(en.signupRisk.retry);
  expect(html).not.toContain("0 teams in queue");
});
