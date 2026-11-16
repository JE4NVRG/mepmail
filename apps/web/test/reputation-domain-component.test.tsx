import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TeamReputation } from "../src/components/team-reputation";

const state = vi.hoisted(() => ({
  domainId: null as string | null,
  locale: "en",
  calls: [] as unknown[],
  reputation: { isPending: true } as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    state.domainId,
    (v: string | null) => {
      state.domainId = v;
    },
  ],
  useId: () => "scope-test",
}));
vi.mock("next-intl", () => ({ useLocale: () => state.locale }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    domains: { list: { queryOptions: () => ({ kind: "domains" }) } },
    reputation: {
      get: {
        queryOptions: (input: unknown) => {
          state.calls.push(input);
          return { kind: "rep" };
        },
      },
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { kind: string }) =>
    options.kind === "domains"
      ? {
          isSuccess: true,
          data: [
            { id: "mature", name: "mature.invalid", status: "verified" },
            { id: "fresh", name: "fresh.invalid", status: "pending" },
          ],
        }
      : state.reputation,
}));
type TreeProps = { children?: unknown; onChange?: (event: { target: { value: string } }) => void };
function nodes(n: unknown): ReactElement<TreeProps>[] {
  if (!isValidElement<TreeProps>(n)) return [];
  return [n, ...[n.props.children].flat(5).flatMap(nodes)];
}
describe("actual customer component explicit domain selection", () => {
  for (const locale of ["en", "pt-BR"])
    it(locale + " labels principal and binds both explicit selections", () => {
      state.locale = locale;
      state.domainId = null;
      state.calls = [];
      let html = renderToStaticMarkup(createElement(TeamReputation));
      expect(html).toContain(
        locale === "en" ? "not a sending-domain allowance" : "não são os limites",
      );
      expect(html).toContain('for="scope-test"');
      expect(html).toContain('aria-describedby="scope-test-scope"');
      let tree = TeamReputation();
      let select = nodes(tree).find((n) => n.type === "select");
      if (!select || typeof select.props.onChange !== "function")
        throw new Error("Expected real domain select handler");
      select.props.onChange({ target: { value: "mature" } });
      html = renderToStaticMarkup(createElement(TeamReputation));
      expect(state.calls.at(-1)).toEqual({ domainId: "mature" });
      expect(html).toContain("mature.invalid");
      tree = TeamReputation();
      select = nodes(tree).find((n) => n.type === "select");
      if (!select || typeof select.props.onChange !== "function")
        throw new Error("Expected refreshed domain select handler");
      select.props.onChange({ target: { value: "fresh" } });
      html = renderToStaticMarkup(createElement(TeamReputation));
      expect(state.calls.at(-1)).toEqual({ domainId: "fresh" });
      expect(html).toContain(locale === "en" ? "DNS not verified" : "DNS não verificado");
      expect(html).not.toContain(">100%<");
    });
});
