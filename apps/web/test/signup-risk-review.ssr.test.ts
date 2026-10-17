// Isolated rendering: no database, operator decision or outbound message.
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { SignupRiskReview } from "@/components/console/safety/signup-risk-review";
import messages from "../messages/en/console.json";

const fixture = vi.hoisted(() => ({
  query: {
    data: null as null | { level: "good" | "sandbox" | "hold"; clearedAt: Date | null },
    isError: false,
    refetch: vi.fn(),
  },
  mutation: { isPending: false, error: null, mutate: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => fixture.query,
  useMutation: () => fixture.mutation,
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    console: {
      teams: {
        signupRisk: { queryOptions: (value: unknown) => value },
        clearSignupRisk: { mutationOptions: (value: unknown) => value },
      },
    },
  }),
}));

beforeEach(() => {
  fixture.query.data = null;
  fixture.query.isError = false;
  fixture.mutation.isPending = false;
  fixture.mutation.mutate.mockReset();
});

function render() {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      timeZone: "UTC",
      messages: { console: messages },
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: createElement(SignupRiskReview, {
        teamId: "00000000-0000-4000-8000-000000000001",
      }),
    }),
  );
}

it.each(["sandbox", "hold"] as const)(
  "%s renders an unarmed review with mandatory explanation and unchanged-holds notice",
  (level) => {
    fixture.query.data = { level, clearedAt: null };
    const html = render();
    expect(html).toContain(messages.signupRisk.levels[level]);
    expect(html).toContain(messages.signupRisk.scope);
    expect(html).toMatch(/<textarea[^>]*minLength="15"[^>]*maxLength="500"[^>]*required=""/);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(fixture.mutation.mutate).not.toHaveBeenCalled();
  },
);

it.each(["good", "cleared"] as const)("%s has no review form", (kind) => {
  fixture.query.data = {
    level: kind === "good" ? "good" : "sandbox",
    clearedAt: kind === "cleared" ? new Date("2026-10-17T00:00:00Z") : null,
  };
  const html = render();
  expect(html).toContain(messages.signupRisk.levels.good);
  expect(html).not.toContain("<form");
  expect(fixture.mutation.mutate).not.toHaveBeenCalled();
});

it("legacy absence does not invent a restriction or any write", () => {
  expect(render()).toBe("");
  expect(fixture.mutation.mutate).not.toHaveBeenCalled();
});

it("load failure exposes retry without offering clearance", () => {
  fixture.query.isError = true;
  const html = render();
  expect(html).toContain('role="alert"');
  expect(html).toContain(messages.signupRisk.retry);
  expect(html).not.toContain('type="submit"');
  expect(fixture.mutation.mutate).not.toHaveBeenCalled();
});
