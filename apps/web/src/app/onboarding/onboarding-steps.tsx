"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { LANG_META, LangIcon } from "@/components/api-sheet";
import { CodeHighlight } from "@/components/code-highlight";
import { CopyGlyph } from "@/components/copy-chip";
import { DeliveredOdometer } from "@/components/delivered-odometer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatusBadge } from "@/components/status-badge";
import { useTurnstile } from "@/components/turnstile";
import { MIGRATE_DOCS_URL } from "@/lib/docs-links";
import { formatDayTime, formatUtcTimestamp, maskApiKey } from "@/lib/format";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import {
  onboardingSnippet,
  SNIPPET_HLJS,
  SNIPPET_LABELS,
  SNIPPET_LANGS,
  type SnippetLang,
  type SnippetParams,
} from "./snippets";

/** Statuses that can still progress to delivered (see emailStatusEnum). */
const IN_FLIGHT_STATUSES = new Set(["queued_quota", "queued", "sent", "delivery_delayed"]);

const TERMINAL_STATUSES = new Set(["bounced", "complained", "suppressed", "failed", "canceled"]);

/** A send attempt is not a delivery milestone; counters outlive email retention. */
export function deriveOnboardingState({
  hasEmail,
  latestStatus,
  allTimeDelivered,
  hasDeliveredEvent = false,
}: {
  hasEmail: boolean;
  latestStatus?: string | undefined;
  allTimeDelivered: number;
  hasDeliveredEvent?: boolean;
}): "no-send" | "in-flight" | "failed" | "delivered" {
  if (allTimeDelivered > 0 || hasDeliveredEvent || latestStatus === "delivered") return "delivered";
  if (!hasEmail) return "no-send";
  return TERMINAL_STATUSES.has(latestStatus ?? "") ? "failed" : "in-flight";
}

const EXPLORE = [
  { key: "domains", href: "/domains", recommended: true },
  { key: "mcp", href: "/settings/mcp" },
  { key: "webhooks", href: "/webhooks" },
  { key: "team", href: "/settings" },
  { key: "migrate", href: MIGRATE_DOCS_URL, external: true },
] as const;

/** Left rail of a stepper row: marker (✓ or number) above the connector line. */
function StepRail({
  marker,
  color,
  line = true,
}: {
  marker: string;
  color: string;
  line?: boolean;
}) {
  return (
    <div
      className="ms-stepper-rail"
      style={{
        width: 30,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <span className="ms-mono" style={{ fontSize: 11, color }}>
        {marker}
      </span>
      {line ? (
        <span style={{ flex: 1, width: 1, background: "var(--ms-line)", marginTop: 6 }} />
      ) : null}
    </div>
  );
}

/** A stepper card: title with a ✓ once done, one-line body, then the step's content. */
function StepCard({
  title,
  body,
  done = false,
  locked = false,
  children,
}: {
  title: string;
  body: string;
  done?: boolean;
  locked?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="ms-card"
      style={{
        flex: 1,
        padding: 22,
        marginBottom: 20,
        ...(done ? { backgroundImage: statusGlow("success", 12) } : {}),
        ...(locked ? { opacity: 0.5 } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ms-bone)" }}>
          {title}
        </h2>
        {done ? (
          <span aria-hidden="true" style={{ color: "var(--ms-success)", fontSize: 14 }}>
            ✓
          </span>
        ) : null}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--ms-muted)" }}>{body}</p>
      {children}
    </section>
  );
}

/** Hairline row: a ✓ or status badge, the sentence, and its time at the right. */
function StampRow({ children, at }: { children: React.ReactNode; at?: Date | string | undefined }) {
  const locale = useLocale();
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        padding: "8px 2px",
        borderBottom: "1px solid var(--ms-line)",
        fontSize: 13.5,
        color: "var(--ms-muted)",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{children}</span>
      {at ? (
        <span style={{ fontSize: 11, color: "var(--ms-faint)" }} title={formatUtcTimestamp(at)}>
          {formatDayTime(at, locale)}
        </span>
      ) : null}
    </div>
  );
}

export function OnboardingSteps({
  userEmail,
  apiUrl,
  showInstanceHint,
  turnstileSiteKey,
}: {
  userEmail: string;
  apiUrl: string;
  /** Instance settings exist only on self-host; cloud hides the pointer. */
  showInstanceHint: boolean;
  /** Set when the instance verifies a Turnstile token on the send. */
  turnstileSiteKey: string | null;
}) {
  const t = useTranslations("onboarding");
  const locale = useLocale();
  const mailLocale = locale === "pt-BR" ? "pt-BR" : "en";
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [lang, setLang] = useState<SnippetLang>("node");
  const turnstile = useTurnstile(turnstileSiteKey);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Self-host: sending needs SES connected, so the stepper leads with that
  // when credentials are absent. Polls until connected (the SES settings
  // page is a different tab away); cloud always passes.
  const awsQuery = useQuery({
    ...trpc.system.awsReadiness.queryOptions(),
    enabled: showInstanceHint,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.credentialsConfigured ? false : 8000),
  });
  const sesReady = !showInstanceHint || awsQuery.data?.credentialsConfigured === true;
  // Extra leading step shifts the numbering below it.
  const marker = (step: number) => String(step + (sesReady ? 0 : 1)).padStart(2, "0");

  const features = useQuery(trpc.system.features.queryOptions());
  const sender = features.data?.onboardingSender ?? null;

  const keysQuery = useQuery(trpc.apiKeys.list.queryOptions());
  const keys = keysQuery.data ?? [];
  // Oldest key = the one this flow banked (list is newest-first).
  const bankedKey = keys[keys.length - 1];
  const hasKey = keys.length > 0;

  const domainsQuery = useQuery(trpc.domains.list.queryOptions());
  const verifiedDomain = domainsQuery.data?.find((d) => d.status === "verified")?.name;
  // A domain still waiting for its DNS records; SES gives up on it 72 hours in.
  const pendingDomain = domainsQuery.data?.find(
    (d) => d.status === "pending" || d.status === "temporary_failure",
  );

  // Keep the first attempt as history, not as the team's current progress.
  // Reads must not depend on an active key: keys can be revoked after sending.
  const emailsQuery = useQuery({
    ...trpc.emails.list.queryOptions({ limit: 1, order: "asc" }),
    refetchInterval: 5000,
  });
  const firstEmail = emailsQuery.data?.items[0];
  const emailCount = emailsQuery.data?.total ?? 0;

  const latestQuery = useQuery({
    ...trpc.emails.list.queryOptions({ limit: 1, order: "desc" }),
    enabled: emailCount > 1,
    refetchInterval: 5000,
  });
  const currentEmail = emailCount > 1 ? latestQuery.data?.items[0] : firstEmail;

  // Keeps ticking while the page is open: the odometer rolls on every delivery.
  const metricsQuery = useQuery({
    ...trpc.metrics.window.queryOptions({}),
    refetchInterval: 5000,
  });

  const detailQuery = useQuery({
    ...trpc.emails.get.queryOptions({ id: currentEmail?.id ?? "" }),
    enabled: currentEmail !== undefined,
    // Poll the current attempt; an old bounce must not stop tracking a retry.
    refetchInterval: (query) => {
      const status = query.state.data?.latestStatus;
      return status === undefined || IN_FLIGHT_STATUSES.has(status) ? 5000 : false;
    },
  });
  const detail = detailQuery.data;
  const deliveredEvent = detail?.events.find((e) => e.type === "delivered");
  const currentStatus = detail?.latestStatus ?? currentEmail?.latestStatus;
  // A confirmed event/status can arrive before the aggregate counter refreshes.
  const deliveredCount = Math.max(
    metricsQuery.data?.allTimeDelivered ?? 0,
    deliveredEvent || currentStatus === "delivered" ? 1 : 0,
  );
  const deliveryState = deriveOnboardingState({
    hasEmail: currentEmail !== undefined,
    latestStatus: currentStatus,
    allTimeDelivered: deliveredCount,
    hasDeliveredEvent: deliveredEvent !== undefined,
  });
  const success = deliveryState === "delivered";
  const deliveredSeconds =
    detail && deliveredEvent
      ? (
          (new Date(deliveredEvent.occurredAt).getTime() - new Date(detail.createdAt).getTime()) /
          1000
        ).toFixed(1)
      : null;

  const createKey = useMutation(
    trpc.apiKeys.create.mutationOptions({
      onSuccess: (data) => {
        setToken(data.token);
        queryClient.invalidateQueries({ queryKey: trpc.apiKeys.list.queryKey() });
      },
    }),
  );
  const sendFirst = useMutation(
    trpc.onboarding.sendFirstEmail.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.emails.pathKey() }),
    }),
  );

  const maskedKey = token
    ? maskApiKey(token, token.slice(-4))
    : bankedKey
      ? maskApiKey(bankedKey.tokenPrefix, bankedKey.last4)
      : "ms_…";

  const snippetBase = {
    apiUrl,
    // API requests use the team's own verified domain, not the platform demonstration sender.
    from: verifiedDomain ? `onboarding@${verifiedDomain}` : t("step2.fromPlaceholder"),
    to: userEmail,
    subject: t("step2.subject"),
    html: t.raw("step2.html"),
  };
  // Honest key handling: only while the real token is in memory may the
  // snippet promise (and deliver) the real key on copy. Otherwise both the
  // display and the copy carry the mask plus a replace-it instruction.
  const comment = token
    ? t("step2.keyComment")
    : hasKey
      ? t("step2.keyCommentReplace")
      : t("step2.keyCommentLocked");
  const displayParams: SnippetParams = { ...snippetBase, apiKey: maskedKey, comment };
  const copyParams: SnippetParams = token ? { ...snippetBase, apiKey: token } : displayParams;
  const displayCode = onboardingSnippet(lang, displayParams);
  const copyCode = onboardingSnippet(lang, copyParams);

  // Wait for the real milestone and current attempt on reload/team navigation.
  const progressQueries = [
    keysQuery,
    features,
    emailsQuery,
    metricsQuery,
    ...(showInstanceHint ? [awsQuery] : []),
    ...(emailCount > 1 ? [latestQuery] : []),
    ...(currentEmail !== undefined ? [detailQuery] : []),
  ];
  const loading = progressQueries.some((query) => query.isPending);
  const readUnavailable = progressQueries.some((query) => query.isError);

  const toDisplay = currentEmail?.to.join(", ") ?? userEmail;

  // After the test send, the one thing between a team and real sending is its
  // own verified domain: say so first, before anything else to explore.
  const nextStep =
    firstEmail && domainsQuery.isSuccess && !verifiedDomain ? (
      <section
        className="ms-card"
        data-testid="onboarding-next-domain"
        style={{ marginTop: 28, padding: 22, backgroundImage: statusGlow("success", 10) }}
      >
        <div className="ms-microlabel">{t("next.label")}</div>
        <h2 style={{ margin: "6px 0 0", fontSize: 18, fontWeight: 600, color: "var(--ms-bone)" }}>
          {pendingDomain
            ? t("next.finishTitle", { domain: pendingDomain.name })
            : t("next.addTitle")}
        </h2>
        <p style={{ margin: "6px 0 0", fontSize: 13.5, color: "var(--ms-muted)", lineHeight: 1.5 }}>
          {pendingDomain
            ? t("next.finishBody", {
                deadline: formatDayTime(
                  new Date(pendingDomain.createdAt).getTime() + 72 * 3_600_000,
                  locale,
                ),
              })
            : t("next.addBody")}
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 14,
            marginTop: 16,
          }}
        >
          <Link
            href={pendingDomain ? `/domains/${pendingDomain.id}` : "/domains/new"}
            className="ms-btn ms-btn-primary"
          >
            {pendingDomain ? t("next.finishCta") : t("next.addCta")}
          </Link>
          <Link href="/support#chat" style={{ fontSize: 13, color: "var(--ms-bone)" }}>
            {t("next.help")}
          </Link>
        </div>
      </section>
    ) : null;

  const explore = (
    <div style={{ marginTop: 56 }}>
      <div className="ms-microlabel" style={{ marginBottom: 10 }}>
        {t("explore.label")}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {EXPLORE.map((card) => (
          <div
            key={card.key}
            className="ms-card"
            style={{ display: "flex", flexDirection: "column" }}
          >
            <div style={{ padding: 18, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ms-bone)" }}>
                  {t(`explore.${card.key}.title`)}
                </span>
                {"recommended" in card ? (
                  <span className="ms-badge ms-badge-success">{t("explore.recommended")}</span>
                ) : null}
              </div>
              <p
                style={{
                  fontSize: 12.5,
                  color: "var(--ms-muted)",
                  margin: "4px 0 0",
                  lineHeight: 1.5,
                }}
              >
                {t(`explore.${card.key}.body`)}
              </p>
            </div>
            <div style={{ borderTop: "1px solid var(--ms-line)", padding: "12px 18px" }}>
              <Link
                href={card.href}
                className="ms-btn ms-btn-secondary"
                {...("external" in card ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {t(`explore.${card.key}.cta`)}
                {"external" in card ? " ↗" : ""}
              </Link>
            </div>
          </div>
        ))}
      </div>
      {showInstanceHint ? (
        <p style={{ fontSize: 12.5, color: "var(--ms-muted)", margin: "14px 0 0" }}>
          {t.rich("explore.instance", {
            link: (chunks) => (
              <Link href="/settings" style={{ color: "var(--ms-bone)" }}>
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}
    </div>
  );

  if (readUnavailable) {
    return (
      <div>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0 }}>
          {t("attempt.readUnavailableTitle")}
        </h1>
        <p role="alert" style={{ marginTop: 16, color: "var(--ms-muted)" }}>
          {t("attempt.readUnavailable")}
        </p>
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={progressQueries.some((query) => query.isFetching)}
          onClick={() => void Promise.all(progressQueries.map((query) => query.refetch()))}
        >
          {t("attempt.reload")}
        </button>
        <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
          {firstEmail ? (
            <Link href={`/emails/${firstEmail.id}`}>
              {t("attempt.first")} · {t("attempt.log")}
            </Link>
          ) : null}
          {currentEmail && currentEmail.id !== firstEmail?.id ? (
            <Link href={`/emails/${currentEmail.id}`}>
              {t("attempt.latest")} · {t("attempt.log")}
            </Link>
          ) : null}
          <Link href="/emails">{t("attempt.history")}</Link>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div>
        <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0 }}>
          {t("title")}
        </h1>
        <div style={{ marginTop: 32, display: "grid", gap: 20 }}>
          <Skeleton width="100%" height={132} radius="var(--ms-r-card)" />
          <Skeleton width="100%" height={320} radius="var(--ms-r-card)" />
        </div>
      </div>
    );
  }

  const keyField = (
    <div
      style={{
        marginTop: 14,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line-strong)",
        borderRadius: 10,
      }}
    >
      <span
        className="ms-mono"
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: "var(--ms-bone)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {token && revealed ? token : maskedKey}
      </span>
      {token ? (
        <>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            style={{ height: "auto", padding: "2px 6px", fontSize: 12 }}
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? t("step1.hide") : t("step1.show")}
          </button>
          <CopyGlyph value={token} />
        </>
      ) : (
        <span style={{ fontSize: 12, color: "var(--ms-muted)", flex: "none" }}>
          {t("step1.doneMeta")}
        </span>
      )}
    </div>
  );

  const codePanel = (
    <div
      style={{
        background: "var(--ms-inset)",
        border: "1px solid var(--ms-line)",
        borderRadius: 10,
        overflow: "hidden",
        marginTop: 14,
      }}
    >
      <div
        role="tablist"
        aria-label={t("step2.title")}
        className="ms-scroll-x"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "7px 8px",
          borderBottom: "1px solid var(--ms-line)",
          overflowX: "auto",
        }}
      >
        {SNIPPET_LANGS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={key === lang}
            className={key === lang ? "ms-code-tab active" : "ms-code-tab"}
            onClick={() => setLang(key)}
          >
            {key !== "curl" ? <LangIcon path={LANG_META[key].icon.path} /> : null}
            {SNIPPET_LABELS[key]}
          </button>
        ))}
        <span style={{ marginLeft: "auto", padding: "0 4px", flex: "none" }}>
          <CopyGlyph value={copyCode} />
        </span>
      </div>
      <pre
        className="ms-mono ms-hl"
        style={{
          margin: 0,
          padding: "14px 16px",
          fontSize: 13,
          lineHeight: 1.7,
          color: "var(--ms-bone)",
          overflowX: "auto",
        }}
      >
        <CodeHighlight code={displayCode} language={SNIPPET_HLJS[lang]} />
      </pre>
    </div>
  );

  const demoPanel = sender ? (
    <StepCard title={t("demo.title")} body={t("demo.body", { from: sender, to: userEmail })}>
      {deliveryState === "failed" && currentEmail ? (
        <>
          <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("attempt.retryBody")}
          </p>
          <Link
            href={`/emails/${currentEmail.id}`}
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 14 }}
          >
            {t("attempt.log")}
          </Link>
        </>
      ) : null}
      <div
        className="ms-wrap-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 14,
        }}
      >
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={verifying || sendFirst.isPending || deliveryState === "in-flight"}
          onClick={async () => {
            setCaptchaFailed(false);
            setVerifying(true);
            try {
              const token = await turnstile.getToken();
              sendFirst.mutate({ locale: mailLocale, ...(token ? { captchaToken: token } : {}) });
            } catch {
              setCaptchaFailed(true);
            } finally {
              setVerifying(false);
            }
          }}
        >
          <BtnSpinner on={verifying || sendFirst.isPending} />
          {verifying || sendFirst.isPending
            ? t("step2.sending")
            : deliveryState === "in-flight"
              ? t("attempt.waiting")
              : deliveryState === "failed"
                ? t("attempt.retryCta")
                : t("demo.sendCta")}
        </button>
        {turnstile.slot}
        {sendFirst.isSuccess && deliveryState !== "failed" ? (
          <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>
            {t("step2.sentTo", { to: userEmail })}
          </span>
        ) : captchaFailed || sendFirst.error?.data?.code === "FORBIDDEN" ? (
          <span style={{ fontSize: 13, color: "var(--ms-danger)" }}>
            {t("step2.captchaFailed")}
          </span>
        ) : sendFirst.error?.data?.code === "TOO_MANY_REQUESTS" ? (
          <span style={{ fontSize: 13, color: "var(--ms-muted)" }}>{t("step2.sendLimited")}</span>
        ) : sendFirst.isError ? (
          <span style={{ fontSize: 13, color: "var(--ms-danger)" }}>{t("step2.sendError")}</span>
        ) : null}
      </div>
    </StepCard>
  ) : null;

  return (
    <div style={{ overflow: "hidden" }}>
      <h1 className="ms-display" style={{ fontSize: "var(--ms-fs-h1)", margin: 0 }}>
        {success
          ? t("success.title")
          : deliveryState === "in-flight"
            ? t("attempt.inFlightTitle")
            : deliveryState === "failed"
              ? t("attempt.failedTitle")
              : t("title")}
      </h1>
      <div style={{ fontSize: 14, color: "var(--ms-muted)", marginTop: 6 }}>
        {success
          ? t("success.subtitle")
          : deliveryState === "in-flight"
            ? t("attempt.inFlight")
            : deliveryState === "failed"
              ? t("attempt.failed")
              : t("subtitle")}
      </div>

      {nextStep}

      {success ? (
        <>
          <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
            {hasKey ? (
              <StampRow at={bankedKey?.createdAt}>
                <span style={{ color: "var(--ms-success)" }}>✓</span>
                {t("success.keyAdded")}
              </StampRow>
            ) : null}
            {verifiedDomain ? (
              <StampRow>
                <span style={{ color: "var(--ms-success)" }}>✓</span>
                {t("success.domainVerified", { domain: verifiedDomain })}
              </StampRow>
            ) : null}
            <StampRow at={deliveredEvent?.occurredAt}>
              <span style={{ color: "var(--ms-success)" }}>✓</span>
              {deliveredSeconds
                ? t("success.emailDelivered", { to: toDisplay, seconds: deliveredSeconds })
                : t("success.deliveryConfirmed")}
            </StampRow>
          </div>

          <div style={{ textAlign: "center", marginTop: 56 }}>
            <DeliveredOdometer value={deliveredCount} locale={locale} />
            <div style={{ fontSize: 15, color: "var(--ms-bone)", marginTop: 18 }}>
              {t("success.counting", { count: deliveredCount })}
            </div>
            {deliveredSeconds ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 8 }}
              >
                {t("success.deliveredIn", { seconds: deliveredSeconds })}
              </div>
            ) : null}
            {/* The first send's route only reads as a story while it is the only one. */}
            {detail && emailCount <= 1 ? (
              <div
                className="ms-mono"
                style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 3 }}
              >
                {detail.from} → {toDisplay}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div style={{ marginTop: 32, display: "flex", flexDirection: "column" }}>
          {!sesReady ? (
            /* Leading step — connect AWS SES before anything can send */
            <div className="ms-step" style={{ display: "flex", gap: 18 }}>
              <StepRail marker="01" color="var(--ms-bone)" />
              <StepCard title={t("stepSes.title")} body={t("stepSes.body")}>
                <Link
                  href="/settings/ses"
                  className="ms-btn ms-btn-primary"
                  style={{ marginTop: 16 }}
                >
                  {t("stepSes.cta")}
                </Link>
              </StepCard>
            </div>
          ) : null}

          {demoPanel}

          {/* Add an API key */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail
              marker={hasKey ? "✓" : marker(1)}
              color={hasKey ? "var(--ms-success)" : "var(--ms-bone)"}
            />
            <StepCard
              title={t("step1.title")}
              body={hasKey ? t("step1.done") : t("step1.body")}
              done={hasKey}
            >
              {hasKey ? (
                keyField
              ) : (
                <>
                  {createKey.isError ? (
                    <div style={{ fontSize: 13, color: "var(--ms-danger)", marginTop: 10 }}>
                      {t("step1.error")}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="ms-btn ms-btn-primary"
                    style={{ marginTop: 16 }}
                    disabled={createKey.isPending}
                    onClick={() => createKey.mutate({ name: t("step1.keyName") })}
                  >
                    <BtnSpinner on={createKey.isPending} />
                    {t("step1.cta")}
                  </button>
                </>
              )}
            </StepCard>
          </div>

          {/* Send an email */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail marker={marker(2)} color={hasKey ? "var(--ms-bone)" : "var(--ms-faint)"} />
            <StepCard
              title={t("step2.title")}
              body={!hasKey ? t("step2.bodyLocked") : t("step2.bodyReady")}
              locked={!hasKey}
            >
              {codePanel}
              {showInstanceHint && lang !== "curl" ? (
                <p
                  className="ms-mono"
                  style={{ margin: "10px 0 0", fontSize: 12, color: "var(--ms-muted)" }}
                >
                  {t("step2.selfHostBase", { url: apiUrl })}
                </p>
              ) : null}
            </StepCard>
          </div>

          {/* Watch it arrive */}
          <div className="ms-step" style={{ display: "flex", gap: 18 }}>
            <StepRail marker={marker(3)} color="var(--ms-faint)" line={false} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 14, color: hasKey ? "var(--ms-muted)" : "var(--ms-faint)" }}>
                {t("step3.title")}
              </span>
              {hasKey ? (
                <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
                  {deliveryState === "no-send"
                    ? t("step3.waiting")
                    : deliveryState === "failed"
                      ? t("attempt.failed")
                      : t("attempt.waiting")}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {firstEmail || success ? (
        <section style={{ marginTop: 32 }}>
          <h2 className="ms-microlabel">{t("attempt.label")}</h2>
          {firstEmail
            ? [
                firstEmail,
                ...(currentEmail && currentEmail.id !== firstEmail.id ? [currentEmail] : []),
              ].map((email, index) => (
                <StampRow key={email.id} at={email.createdAt}>
                  {t(index === 0 ? "attempt.first" : "attempt.latest")}
                  <StatusBadge
                    status={
                      email.id === currentEmail?.id
                        ? (currentStatus ?? email.latestStatus)
                        : email.latestStatus
                    }
                  />
                  <Link href={`/emails/${email.id}`} style={{ color: "var(--ms-bone)" }}>
                    {t("attempt.log")}
                  </Link>
                </StampRow>
              ))
            : null}
          <Link href="/emails" className="ms-btn ms-btn-secondary" style={{ marginTop: 12 }}>
            {t("attempt.history")}
          </Link>
        </section>
      ) : null}

      {explore}
    </div>
  );
}
