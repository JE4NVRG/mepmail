import { readFileSync } from "node:fs";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetricsPage from "@/app/(dashboard)/metrics/page";
import { DeliverabilityBanner, DeliverabilityRecovery } from "@/components/deliverability-banner";
import { DOCS_URL } from "@/lib/docs-links";
import enCommon from "../messages/en/common.json";
import enDeliverability from "../messages/en/deliverability.json";
import enMetrics from "../messages/en/metrics.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptDeliverability from "../messages/pt-BR/deliverability.json";
import ptMetrics from "../messages/pt-BR/metrics.json";

type Health = NonNullable<Parameters<typeof DeliverabilityRecovery>[0]["health"]>;
const fixture = vi.hoisted(() => ({
  health: undefined as Health | undefined,
  healthFailed: false,
  healthPending: false,
  score: {} as Record<string, unknown>,
  mutations: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    metrics: Object.fromEntries(
      ["health", "window", "accountScore"].map((key) => [
        key,
        { queryOptions: () => ({ queryKey: [key] }) },
      ]),
    ),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey: [key] }: { queryKey: [string] }) => ({
    data:
      key === "health"
        ? fixture.health
        : key === "accountScore"
          ? fixture.score
          : {
              today: "2026-10-05",
              allTimeDelivered: 90,
              days: [
                {
                  day: "2026-10-05",
                  sent: 100,
                  delivered: 90,
                  hardBounced: 10,
                  complained: 1,
                  opened: 10,
                  clicked: 5,
                },
              ],
              totals: {
                accepted: 100,
                sent: 100,
                delivered: 90,
                hardBounced: 10,
                complained: 1,
                opened: 10,
                clicked: 5,
                prefetched: 0,
              },
            },
    isError: key === "health" && fixture.healthFailed,
    isPending: key === "health" && fixture.healthPending,
  }),
  useMutation: fixture.mutations,
}));
vi.mock("@/lib/url-state", () => ({ useUrlState: () => ["15", vi.fn()] }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));
vi.mock("@/components/odometer", () => ({
  Odometer: ({ formatted }: { formatted: string }) => createElement("span", null, formatted),
}));
vi.mock("@/components/line-chart", () => ({ LineChart: () => null, ChartTip: () => null }));
vi.mock("@/components/select", () => ({ Select: () => null }));
vi.mock("@/app/(dashboard)/metrics/score-details", () => ({ ScoreDetailsDrawer: () => null }));

const instant = new Date("2026-10-05T12:00:00Z");
const messages = {
  en: { common: enCommon, deliverability: enDeliverability, metrics: enMetrics },
  "pt-BR": { common: ptCommon, deliverability: ptDeliverability, metrics: ptMetrics },
};
type Locale = keyof typeof messages;

function health(overrides: Partial<Health> = {}): Health {
  return {
    status: "paused",
    sent: 1000,
    windowDays: 7,
    bounceRate: 0.02,
    complaintRate: 0.001,
    pause: { sent: 200, hardBounced: 10, complained: 0, windowDays: 2 },
    reasons: [{ metric: "bounce", rate: 0.05, tier: "paused", windowDays: 2 }],
    thresholds: {
      warnBounce: 0.04,
      warnComplaint: 0.0005,
      pauseBounce: 0.05,
      pauseComplaint: 0.001,
    },
    recovery: {
      evaluatedAt: instant,
      reevaluationEarliestAt: null,
      basis: "window_totals",
      condition: "no_new_sends_or_events",
      projectedStatus: null,
    },
    ...overrides,
  };
}

function render(locale: Locale, child: ReactNode) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messages[locale],
      now: instant,
      timeZone: "America/Sao_Paulo",
      // biome-ignore lint/correctness/noChildrenProp: next-intl requires children in its props type.
      children: child,
    }),
  );
}

function plain(html: string) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.health = health();
  fixture.healthFailed = false;
  fixture.healthPending = false;
  fixture.score = {
    scoreTenths: 90,
    contentScoreTenths: 90,
    outcomeScoreTenths: 100,
    band: null,
    guardrailStatus: "ok",
    insufficientOutcomeData: false,
    complaintRate: 0.01,
    hardBounceRate: 0,
    outcomeConfidence: {
      level: "provisional",
      sent: 100,
      minOutcomeSends: 100,
      complaintEvents: 1,
      minComplaintEvents: 2,
      complaintPenaltyEligible: false,
    },
  };
});

describe.each(["en", "pt-BR"] as const)("deliverability recovery in %s", (locale) => {
  const t = createTranslator({ locale, messages: messages[locale], namespace: "deliverability" });
  const scoreT = createTranslator({ locale, messages: messages[locale], namespace: "metrics" });
  const fmt = new Intl.NumberFormat(locale);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });

  it("uses actual short-window events in the banner and links to next steps", () => {
    const html = render(locale, createElement(DeliverabilityBanner));
    const text = plain(html);
    expect(text).toContain(
      t("banner.paused.bounce", {
        count: fmt.format(10),
        sent: fmt.format(200),
        rate: pct.format(0.05),
      }),
    );
    expect(text).toContain(t("banner.action"));
    expect(html).toContain('href="/metrics"');
    expect(text).not.toContain(pct.format(0.02));
  });

  it.each(["missing", "ok", "error", "pending"] as const)(
    "does not advertise a live pause while health is %s",
    (state) => {
      if (state === "missing") fixture.health = undefined;
      if (state === "ok") fixture.health = health({ status: "ok", reasons: [] });
      fixture.healthFailed = state === "error";
      fixture.healthPending = state === "pending";
      expect(render(locale, createElement(DeliverabilityBanner))).toBe("");
    },
  );

  it("shows both pause causes, real counts, exact floors and safe recovery actions", () => {
    const current = health({
      pause: { sent: 200, hardBounced: 10, complained: 3, windowDays: 2 },
      reasons: [
        { metric: "bounce", rate: 0.05, tier: "paused", windowDays: 2 },
        { metric: "complaint", rate: 0.015, tier: "paused", windowDays: 2 },
      ],
    });
    const html = render(locale, createElement(DeliverabilityRecovery, { health: current }));
    const text = plain(html);
    expect(text).toContain(t("recovery.pauseWindow"));
    expect(text).toContain(t("recovery.criteriaVolume", { sent: fmt.format(100) }));
    expect(text).toContain(
      t("recovery.bounceCriteria", { count: fmt.format(10), rate: pct.format(0.05) }),
    );
    expect(text).toContain(
      t("recovery.complaintCriteria", { count: fmt.format(3), rate: pct.format(0.001) }),
    );
    for (const reason of current.reasons) {
      expect(text).toContain(
        t("recovery.pauseEvidence", {
          metric: t(`metric.${reason.metric}`),
          rate: pct.format(reason.rate),
          count: fmt.format(reason.metric === "bounce" ? 10 : 3),
          sent: fmt.format(200),
          days: 2,
        }),
      );
    }
    for (const step of ["list", "suppressions", "consent"] as const) {
      expect(text).toContain(t(`recovery.steps.${step}`));
    }
    expect(html).toContain('href="/emails/suppressions"');
    expect(html).toContain(`href="${DOCS_URL}/concepts/suppressions"`);
    expect(html).toMatch(/<section[^>]*aria-labelledby="[^"]+"/);
    expect(html).toContain("<ol");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("mailto:");
    expect(fixture.mutations).not.toHaveBeenCalled();
  });

  it("keeps the warning's seven-day window separate from the pause criteria", () => {
    const current = health({
      status: "warning",
      reasons: [{ metric: "bounce", rate: 0.04, tier: "warning", windowDays: 7 }],
    });
    const text = plain(render(locale, createElement(DeliverabilityRecovery, { health: current })));
    expect(text).toContain(t("recovery.status.warning"));
    expect(text).toContain(t("recovery.warningWindow", { days: 7 }));
    expect(text).toContain(
      t("recovery.warningEvidence", {
        metric: t("metric.bounce"),
        rate: pct.format(0.04),
        days: 7,
      }),
    );
    expect(text).not.toContain(t("recovery.status.paused"));
  });

  it("formats a server-provided reevaluation boundary in UTC as a conditional review", () => {
    const date = new Date("2026-10-07T00:00:00Z");
    const current = health({
      recovery: {
        evaluatedAt: instant,
        reevaluationEarliestAt: date,
        basis: "daily_counters",
        condition: "no_new_sends_or_events",
        projectedStatus: "warning",
      },
    });
    const html = render(locale, createElement(DeliverabilityRecovery, { health: current }));
    const formatted = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(date);
    expect(html).toContain('dateTime="2026-10-07T00:00:00.000Z"');
    expect(plain(html)).toContain(t("recovery.reevaluationAt", { date: formatted }));
    expect(plain(html)).toContain(t("recovery.automatic"));
  });

  it.each(["missing", "null", "invalid"] as const)(
    "shows the UTC calendar without inventing a date when recovery is %s",
    (state) => {
      const current = health();
      if (state === "missing") Reflect.deleteProperty(current, "recovery");
      else {
        current.recovery = {
          evaluatedAt: instant,
          reevaluationEarliestAt: state === "invalid" ? new Date(Number.NaN) : null,
          basis: "window_totals",
          condition: "no_new_sends_or_events",
          projectedStatus: null,
        };
      }
      const html = render(locale, createElement(DeliverabilityRecovery, { health: current }));
      expect(plain(html)).toContain(t("recovery.reevaluationPending"));
      expect(html).not.toContain("dateTime=");
      expect(html).not.toContain("Invalid Date");
    },
  );

  it("keeps the score separate from live send protection and explains a lone complaint", () => {
    const text = plain(render(locale, createElement(MetricsPage)));
    expect(text).toContain(t("recovery.status.paused"));
    expect(text).toContain(scoreT("score.authorizationNote"));
    expect(text).toContain(scoreT("score.confidence.title"));
    expect(text).toContain(
      scoreT("score.confidence.provisional", { sent: fmt.format(100), minimum: fmt.format(100) }),
    );
    expect(text).toContain(
      scoreT("score.confidence.complaintSignalPending", {
        count: fmt.format(1),
        events: fmt.format(2),
        sent: fmt.format(100),
      }),
    );
    const actualRate = new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0.01);
    expect(text).toContain(actualRate);
    expect(fixture.mutations).not.toHaveBeenCalled();
  });

  it("explains the insufficient score sample without claiming that it authorizes sending", () => {
    fixture.health = health({ status: "ok", reasons: [] });
    fixture.score = {
      ...fixture.score,
      outcomeScoreTenths: null,
      insufficientOutcomeData: true,
      outcomeConfidence: {
        level: "insufficient",
        sent: 20,
        minOutcomeSends: 100,
        complaintEvents: 0,
        minComplaintEvents: 2,
        complaintPenaltyEligible: false,
      },
    };
    const text = plain(render(locale, createElement(MetricsPage)));
    expect(text).toContain(
      scoreT("score.confidence.insufficient", { sent: fmt.format(20), minimum: fmt.format(100) }),
    );
    expect(text).toContain(scoreT("score.authorizationNote"));
    expect(text).not.toContain(t("recovery.title"));
  });
});

it("reuses the existing visual tokens and keeps keyboard focus for action links", () => {
  const source = readFileSync(
    new URL("../src/components/deliverability-banner.tsx", import.meta.url),
    "utf8",
  );
  const css = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
  expect(source).toContain('className="ms-kpi-card"');
  expect(source).toContain("var(--ms-muted)");
  expect(source).toContain('className="ms-btn ms-btn-primary"');
  expect(source).toContain('flexWrap: "wrap"');
  expect(css).toContain("a:focus-visible");
});
