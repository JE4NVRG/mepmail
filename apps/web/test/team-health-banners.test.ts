import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeamHealthBanners } from "@/components/team-health-banners";

const state = vi.hoisted(() => ({
  data: undefined as { isOperationsMember?: boolean } | undefined,
  probes: [] as string[],
}));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({ system: { operator: { queryOptions: () => ({ query: "operator" }) } } }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.data }) }));
vi.mock("@/components/team-standing-banner", () => ({
  TeamStandingBanner: () => {
    state.probes.push("standing");
    return "standing";
  },
}));
vi.mock("@/components/region-breaker-banner", () => ({
  RegionBreakerBanner: () => {
    state.probes.push("breakers");
    return "breakers";
  },
}));
vi.mock("@/components/events-health-banner", () => ({
  EventsHealthBanner: () => {
    state.probes.push("events");
    return "events";
  },
}));
vi.mock("@/components/deliverability-banner", () => ({
  DeliverabilityBanner: () => {
    state.probes.push("deliverability");
    return "deliverability";
  },
}));
beforeEach(() => {
  state.data = undefined;
  state.probes = [];
});

describe("current-team private health probes", () => {
  it.each([undefined, {}, { isOperationsMember: true }])(
    "does not mount any private probe for unresolved or operational access (%j)",
    (data) => {
      state.data = data;
      expect(renderToStaticMarkup(createElement(TeamHealthBanners))).toBe("");
      expect(state.probes).toEqual([]);
    },
  );
  it("mounts the dashboard's existing probes for a normal team", () => {
    state.data = { isOperationsMember: false };
    renderToStaticMarkup(createElement(TeamHealthBanners));
    expect(state.probes).toEqual(["standing", "breakers", "events", "deliverability"]);
  });
  it("preserves Correio's standing-only banner set", () => {
    state.data = { isOperationsMember: false };
    renderToStaticMarkup(createElement(TeamHealthBanners, { standingOnly: true }));
    expect(state.probes).toEqual(["standing"]);
  });
});
