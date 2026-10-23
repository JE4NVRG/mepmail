import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enCommon from "../messages/en/common.json";
import enConsole from "../messages/en/console.json";
import enDomains from "../messages/en/domains.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptConsole from "../messages/pt-BR/console.json";
import ptDomains from "../messages/pt-BR/domains.json";

let standing: unknown;
let page: unknown;
let pending = false;
let failed = false;
const anyPath: unknown = new Proxy(() => ({}), { get: () => anyPath, apply: () => ({}) });
vi.mock("@/lib/trpc", () => ({ useTRPC: () => anyPath, useTRPCClient: () => anyPath }));
vi.mock("next/navigation", () => ({ usePathname: () => "/emails", useRouter: () => ({}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: standing }),
  useInfiniteQuery: () => ({
    data: page ? { pages: [page] } : undefined,
    isPending: pending,
    isError: failed,
    refetch: vi.fn(),
  }),
  useMutation: () => ({}),
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
vi.mock("@/components/console/team-actions", () => ({ useTeamActions: () => ({ dialogs: null }) }));
vi.mock("@/components/console/safety/reveal", () => ({
  useContentReveal: () => ({ dialogs: null }),
}));
vi.mock("@/lib/url-state", () => ({
  oneOf: (values: string[], value: string, fallback: string) =>
    values.includes(value) ? value : fallback,
  useUrlState: (_: string, value = "") => [value, vi.fn()],
}));
const { TeamStandingBanner } = await import("@/components/team-standing-banner");
const { SafetyList } = await import("@/components/console/safety/safety-list");

const messages = {
  en: { common: enCommon, console: enConsole, domains: enDomains },
  "pt-BR": { common: ptCommon, console: ptConsole, domains: ptDomains },
};
function render(locale: "en" | "pt-BR", component: typeof TeamStandingBanner | typeof SafetyList) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      timeZone: "UTC",
      messages: messages[locale],
      // biome-ignore lint/correctness/noChildrenProp: provider's props require children.
      children: createElement(component),
    }),
  );
}

describe.each(["en", "pt-BR"] as const)("review access and truthful counts (%s)", (locale) => {
  it.each(["sandbox", "review"])(
    "explains signup %s with a review path and no suspension claim",
    (kind) => {
      standing = { signupRisk: kind };
      const html = render(locale, TeamStandingBanner);
      expect(html).toContain('href="/support"');
      expect(html).toContain((locale === "en" ? enConsole : ptConsole).banner.reviewRequest.button);
      expect(html).not.toContain(locale === "en" ? "is suspended" : "está suspensa");
      if (kind === "sandbox")
        expect(html).toContain(locale === "en" ? "your own verified" : "próprio e-mail verificado");
    },
  );
  it.each(["suspended", "sendReview"])(
    "offers support from %s without restoring sending",
    (kind) => {
      standing =
        kind === "suspended"
          ? { suspended: { reason: "phishing", note: "INTERNAL-NOTE" } }
          : { sendReview: { at: new Date("2026-10-16T00:00:00Z") } };
      const html = render(locale, TeamStandingBanner);
      expect(html).toContain('href="/support"');
      expect(html).toContain((locale === "en" ? enConsole : ptConsole).banner.reviewRequest.button);
      expect(html).not.toContain("INTERNAL-NOTE");
    },
  );
  it.each([false, true])("does not report zero suspended teams before data (error=%s)", (error) => {
    page = undefined;
    pending = !error;
    failed = error;
    const html = render(locale, SafetyList);
    expect(html).not.toContain(locale === "en" ? "0 suspended" : "0 suspensas");
  });
  it("reports the loaded count, including a genuine zero", () => {
    pending = false;
    failed = false;
    for (const suspended of [7, 0]) {
      page = {
        counts: { open: 8, guardrailPaused: 0, suspended, revealsThisWeek: 0 },
        items: [],
        total: 0,
      };
      expect(render(locale, SafetyList)).toContain(
        `${suspended} ${locale === "en" ? "suspended" : "suspensas"}`,
      );
    }
  });
});
