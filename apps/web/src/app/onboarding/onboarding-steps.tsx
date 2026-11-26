"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { LANG_META, LangIcon } from "@/components/api-sheet";
import { CodeHighlight } from "@/components/code-highlight";
import { CopyChip, CopyGlyph } from "@/components/copy-chip";
import { DeliveredOdometer } from "@/components/delivered-odometer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { StatusBadge } from "@/components/status-badge";
import { useTurnstile } from "@/components/turnstile";
import { trackEvent } from "@/lib/analytics";
import { MIGRATE_DOCS_URL } from "@/lib/docs-links";
import { formatDayTime, formatUtcTimestamp, maskApiKey } from "@/lib/format";
import {
  MCP_CLIENT_LABELS,
  MCP_CLIENTS,
  type McpClient,
  mcpClientSnippet,
  mcpCopyEvent,
} from "@/lib/mcp-clients";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { DomainFirst } from "./domain-first";
import { useOnboardingTrack } from "./onboarding-track";
import {
  INBOX_HLJS,
  INBOX_LABELS,
  INBOX_LANGS,
  type InboxLang,
  inboxQuickstartSnippet,
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
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {children}
      </span>
      {at ? (
        <span style={{ fontSize: 11.5, color: "var(--ms-muted)" }} title={formatUtcTimestamp(at)}>
          {formatDayTime(at, locale)}
        </span>
      ) : null}
    </div>
  );
}

type OnboardingStepsProps = {
  userEmail: string;
  apiUrl: string;
  mcpUrl?: string;
  /** Instance settings exist only on self-host; cloud hides the pointer. */
  showInstanceHint: boolean;
  /** Set when the instance verifies a Turnstile token on the send. */
  turnstileSiteKey: string | null;
};

/**
 * The post-team onboarding: the domain-first flow leads (domain, DNS, first
 * mailbox, agent); the API quickstart follows for people who start from code.
 */
export function OnboardingSteps(props: OnboardingStepsProps) {
  const t = useTranslations("onboarding.domainFirst");
  return (
    <div>
      <DomainFirst userEmail={props.userEmail} />
      <section
        aria-label={t("api.title")}
        style={{ marginTop: 56, paddingTop: 32, borderTop: "1px solid var(--ms-line)" }}
      >
        <p className="ms-microlabel" style={{ margin: 0 }}>
          {t("api.title")}
        </p>
        <p style={{ margin: "6px 0 24px", fontSize: 13.5, color: "var(--ms-muted)" }}>
          {t("api.body")}
        </p>
        <ApiQuickstart {...props} />
      </section>
    </div>
  );
}

/** Test send, API key and snippet: the first email sent from code. */
export function ApiQuickstart(props: OnboardingStepsProps) {
  return (
    <div id="first-email" style={{ scrollMarginTop: 24 }}>
      <ApiQuickstartContent {...props} />
    </div>
  );
}

function ApiQuickstartContent({
  userEmail,
  apiUrl,
  mcpUrl,
  showInstanceHint,
  turnstileSiteKey,
}: OnboardingStepsProps) {
  const t = useTranslations("onboarding");
  const track = useOnboardingTrack();
  const locale = useLocale();
  const mailLocale = locale === "pt-BR" ? "pt-BR" : "en";
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [lang, setLang] = useState<SnippetLang>("node");
  const [agentTab, setAgentTab] = useState<"mcp" | "api">("mcp");
  const [mcpClient, setMcpClient] = useState<McpClient>("claudeCode");
  const [inboxLang, setInboxLang] = useState<InboxLang>("curl");
  const turnstile = useTurnstile(turnstileSiteKey);
  const [captchaFailed, setCaptchaFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  // Sending through the API with the key that was just minted is the only
  // honest proof the integration works; the platform demo does not use it.
  const [keySend, setKeySend] = useState<{
    state: "idle" | "sending" | "ok" | "error";
    message?: string;
    sentId?: string;
  }>({ state: "idle" });
  const [playFrom, setPlayFrom] = useState<string | null>(null);
  const [playTo, setPlayTo] = useState<string | null>(null);
  const [playSubject, setPlaySubject] = useState<string | null>(null);
  const [playHtml, setPlayHtml] = useState<string | null>(null);

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
    ...trpc.emails.get.queryOptions({ id: currentEmail?.id ?? "", includeBody: false }),
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

  const effectiveFrom =
    playFrom ?? (verifiedDomain ? `onboarding@${verifiedDomain}` : t("step2.fromPlaceholder"));
  const effectiveTo = playTo ?? userEmail;
  const effectiveSubject = playSubject ?? t("step2.subject");
  const effectiveHtml = playHtml ?? t.raw("step2.html");

  const snippetBase = {
    apiUrl,
    // API requests use the team's own verified domain, not the platform demonstration sender.
    from: effectiveFrom,
    to: effectiveTo,
    subject: effectiveSubject,
    html: effectiveHtml,
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

  /**
   * POST /emails with the reveal-once token, exactly like a customer would.
   * The answer is shown verbatim: a 422 that names the suppressed address is
   * more useful here than a friendly paraphrase.
   */
  const sendWithOwnKey = async () => {
    if (!token) return;
    if (!verifiedDomain) {
      setKeySend({ state: "error", message: t("step2.tryNoDomain") });
      return;
    }
    setKeySend({ state: "sending" });
    try {
      const res = await fetch(`${apiUrl}/emails`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          from: effectiveFrom,
          to: effectiveTo,
          subject: effectiveSubject,
          html: effectiveHtml,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      setKeySend(
        res.ok
          ? {
              state: "ok",
              message: body.id ? t("step2.tryOk", { id: body.id }) : t("step2.tryOkNoId"),
              ...(body.id ? { sentId: body.id } : {}),
            }
          : {
              state: "error",
              message: body.message ?? t("step2.tryError", { status: res.status }),
            },
      );
    } catch (error) {
      setKeySend({ state: "error", message: String(error) });
    }
  };

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

  // The same block serves the first-send flow and the state after a delivery:
  // a team that already sends still needs to prove a freshly minted key.
  const keyTestBlock = (
    <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
      {token ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
          }}
        >
          <div className="ms-field">
            <label htmlFor="playground-from">{t("step2.playgroundFrom")}</label>
            <input
              id="playground-from"
              className="ms-input mono"
              style={{ width: "100%" }}
              value={effectiveFrom}
              onChange={(e) => setPlayFrom(e.target.value)}
            />
          </div>
          <div className="ms-field">
            <label htmlFor="playground-to">{t("step2.playgroundTo")}</label>
            <input
              id="playground-to"
              className="ms-input mono"
              style={{ width: "100%" }}
              value={effectiveTo}
              onChange={(e) => setPlayTo(e.target.value)}
            />
          </div>
          <div className="ms-field">
            <label htmlFor="playground-subject">{t("step2.playgroundSubject")}</label>
            <input
              id="playground-subject"
              className="ms-input"
              style={{ width: "100%" }}
              value={effectiveSubject}
              onChange={(e) => setPlaySubject(e.target.value)}
            />
          </div>
          <div className="ms-field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="playground-html">{t("step2.playgroundHtml")}</label>
            <input
              id="playground-html"
              className="ms-input mono"
              style={{ width: "100%" }}
              value={effectiveHtml}
              onChange={(e) => setPlayHtml(e.target.value)}
            />
          </div>
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          className={token ? "ms-btn ms-btn-primary" : "ms-btn ms-btn-secondary"}
          data-testid="onboarding-try-with-key"
          disabled={!token || keySend.state === "sending"}
          onClick={() => void sendWithOwnKey()}
        >
          <BtnSpinner on={keySend.state === "sending"} />
          {keySend.state === "sending" ? t("step2.trySending") : t("step2.tryWithKey")}
        </button>
        {!token && hasKey ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            disabled={createKey.isPending}
            onClick={() => createKey.mutate({ name: "Playground" })}
          >
            <BtnSpinner on={createKey.isPending} />
            {t("step2.playgroundMintKey")}
          </button>
        ) : null}
        {!token && createKey.isError ? (
          <span role="alert" style={{ fontSize: 12.5, color: "var(--ms-danger)" }}>
            {createKey.error?.message || t("step1.error")}
          </span>
        ) : null}
        {!token ? (
          <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-muted)" }}>
            {t("step2.tryNeedsToken")}
          </span>
        ) : null}
        {keySend.state === "ok" ? (
          <span
            className="ms-mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              fontSize: 12,
              color: "var(--ms-success)",
            }}
          >
            <span>{keySend.message}</span>
            {keySend.sentId ? (
              <Link
                href={`/emails/${keySend.sentId}`}
                className="ms-btn ms-btn-secondary ms-btn-sm"
              >
                {t("step2.playgroundViewEmail")}
              </Link>
            ) : null}
          </span>
        ) : null}
        {keySend.state === "error" ? (
          <span className="ms-mono" style={{ fontSize: 12, color: "var(--ms-warn, #b45309)" }}>
            {keySend.message}
          </span>
        ) : null}
      </div>
    </div>
  );

  const explore = (
    <div style={{ marginTop: 48 }}>
      <div className="ms-microlabel" style={{ marginBottom: 10 }}>
        {t("explore.label")}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(195px, 1fr))",
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
                {"recommended" in card && card.recommended && !verifiedDomain ? (
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
        <h2 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("attempt.readUnavailableTitle")}
        </h2>
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
        <h2 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
          {t("title")}
        </h2>
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
    <div id="send-test-inbox" style={{ scrollMarginTop: 24 }}>
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
              track("api_opened");
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
    </div>
  ) : null;

  const resolvedMcpUrl = mcpUrl ?? `${apiUrl.replace(/\/+$/, "")}/mcp`;
  const mcpSnippet = mcpClientSnippet(mcpClient, resolvedMcpUrl);
  const inboxDomain = verifiedDomain ?? t("agentQuickstart.domainFallback");
  const inboxDisplayCode = inboxQuickstartSnippet(inboxLang, {
    apiUrl,
    apiKey: maskedKey,
    domain: inboxDomain,
    comment,
  });
  const inboxCopyCode = inboxQuickstartSnippet(inboxLang, {
    apiUrl,
    apiKey: token ?? maskedKey,
    domain: inboxDomain,
    ...(token ? {} : { comment }),
  });

  const agentQuickstartPanel = (
    <section
      id="agent-quickstart"
      className="ms-card"
      aria-label={t("agentQuickstart.title")}
      style={{ marginTop: 32, padding: 22, scrollMarginTop: 24 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--ms-bone)" }}>
          {t("agentQuickstart.title")}
        </h2>
        <span className="ms-badge ms-badge-success">{t("agentQuickstart.badge")}</span>
      </div>
      <p style={{ margin: "6px 0 16px", fontSize: 13.5, color: "var(--ms-muted)" }}>
        {t("agentQuickstart.subtitle")}
      </p>

      <div role="tablist" aria-label={t("agentQuickstart.title")} className="ms-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={agentTab === "mcp"}
          className={agentTab === "mcp" ? "active" : ""}
          onClick={() => setAgentTab("mcp")}
        >
          {t("agentQuickstart.tabMcp")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={agentTab === "api"}
          className={agentTab === "api" ? "active" : ""}
          onClick={() => setAgentTab("api")}
        >
          {t("agentQuickstart.tabApi")}
        </button>
      </div>

      {agentTab === "mcp" ? (
        <div style={{ marginTop: 16 }}>
          <div className="ms-microlabel" style={{ marginBottom: 6 }}>
            {t("agentQuickstart.serverUrl")}
          </div>
          <CopyChip value={resolvedMcpUrl} />
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
              aria-label={t("agentQuickstart.tabMcp")}
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
              {MCP_CLIENTS.map((clientKey) => (
                <button
                  key={clientKey}
                  type="button"
                  role="tab"
                  aria-selected={mcpClient === clientKey}
                  className={mcpClient === clientKey ? "ms-code-tab active" : "ms-code-tab"}
                  onClick={() => setMcpClient(clientKey)}
                >
                  {MCP_CLIENT_LABELS[clientKey]}
                </button>
              ))}
              <span style={{ marginLeft: "auto", padding: "0 4px", flex: "none" }}>
                <CopyGlyph
                  value={mcpSnippet.code}
                  onCopy={() =>
                    trackEvent(mcpCopyEvent(mcpSnippet.code), {
                      mode: "http",
                      source: "onboarding",
                    })
                  }
                />
              </span>
            </div>
            <pre
              className="ms-mono ms-hl"
              style={{
                margin: 0,
                padding: "14px 16px",
                fontSize: 12.5,
                lineHeight: 1.65,
                color: "var(--ms-bone)",
                overflowX: "auto",
              }}
            >
              <CodeHighlight code={mcpSnippet.code} language={mcpSnippet.language} />
            </pre>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
            {t("agentQuickstart.mcpHint")}
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          {!token ? (
            <div
              className="ms-wrap-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                marginBottom: 12,
              }}
            >
              {verifiedDomain ? (
                <>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary ms-btn-sm"
                    disabled={createKey.isPending}
                    onClick={() => {
                      track("api_opened");
                      createKey.mutate({ name: t("step1.keyName") });
                    }}
                  >
                    <BtnSpinner on={createKey.isPending} />
                    {t("agentQuickstart.mintKey")}
                  </button>
                  {createKey.isError ? (
                    <span role="alert" style={{ fontSize: 12.5, color: "var(--ms-danger)" }}>
                      {createKey.error?.message || t("step1.error")}
                    </span>
                  ) : null}
                </>
              ) : (
                <>
                  <a href="#domain-first" className="ms-btn ms-btn-secondary ms-btn-sm">
                    {t("agentQuickstart.verifyDomainCta")}
                  </a>
                  <span style={{ fontSize: 12.5, color: "var(--ms-muted)" }}>
                    {t("agentQuickstart.needsDomain")}
                  </span>
                </>
              )}
            </div>
          ) : null}
          <div
            style={{
              background: "var(--ms-inset)",
              border: "1px solid var(--ms-line)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div
              role="tablist"
              aria-label={t("agentQuickstart.tabApi")}
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
              {INBOX_LANGS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={key === inboxLang}
                  className={key === inboxLang ? "ms-code-tab active" : "ms-code-tab"}
                  onClick={() => setInboxLang(key)}
                >
                  {INBOX_LABELS[key]}
                </button>
              ))}
              <span style={{ marginLeft: "auto", padding: "0 4px", flex: "none" }}>
                <CopyGlyph value={inboxCopyCode} />
              </span>
            </div>
            <pre
              className="ms-mono ms-hl"
              style={{
                margin: 0,
                padding: "14px 16px",
                fontSize: 12.5,
                lineHeight: 1.65,
                color: "var(--ms-bone)",
                overflowX: "auto",
              }}
            >
              <CodeHighlight code={inboxDisplayCode} language={INBOX_HLJS[inboxLang]} />
            </pre>
          </div>
          <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ms-muted)" }}>
            {t("agentQuickstart.apiHint")}
          </p>
        </div>
      )}

      <div
        className="ms-wrap-row"
        style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}
      >
        <Link href="/mail/settings?tab=agents" className="ms-btn ms-btn-secondary ms-btn-sm">
          {t("agentQuickstart.manageAgents")}
        </Link>
        <Link href="/settings/mcp" style={{ fontSize: 13, color: "var(--ms-muted)" }}>
          {t("agentQuickstart.mcpSettings")}
        </Link>
      </div>
    </section>
  );

  return (
    <div style={{ overflow: "hidden" }}>
      <h2 className="ms-display" style={{ fontSize: "var(--ms-fs-h2)", margin: 0 }}>
        {success
          ? t("success.title")
          : deliveryState === "in-flight"
            ? t("attempt.inFlightTitle")
            : deliveryState === "failed"
              ? t("attempt.failedTitle")
              : t("title")}
      </h2>
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

          <div
            className="ms-card"
            style={{
              marginTop: 24,
              padding: "22px 26px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "16px 24px",
              backgroundImage: statusGlow("success", 8),
            }}
          >
            <div>
              <DeliveredOdometer value={deliveredCount} locale={locale} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ms-bone)" }}>
                {t("success.counting", { count: deliveredCount })}
              </div>
              {deliveredSeconds ? (
                <div
                  className="ms-mono"
                  style={{ fontSize: 12, color: "var(--ms-muted)", marginTop: 6 }}
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
                    <div
                      role="alert"
                      style={{ fontSize: 13, color: "var(--ms-danger)", marginTop: 10 }}
                    >
                      {createKey.error?.message || t("step1.error")}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="ms-btn ms-btn-primary"
                    style={{ marginTop: 16 }}
                    disabled={createKey.isPending}
                    onClick={() => {
                      track("api_opened");
                      createKey.mutate({ name: t("step1.keyName") });
                    }}
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
              {keyTestBlock}
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

      {success ? (
        <section
          className="ms-card"
          aria-label={t("step2.tryTitle")}
          style={{ marginTop: 32, padding: 22 }}
        >
          <p className="ms-microlabel" style={{ margin: 0 }}>
            {t("step2.tryTitle")}
          </p>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("step2.tryBody")}
          </p>
          {codePanel}
          {keyTestBlock}
        </section>
      ) : null}

      {agentQuickstartPanel}

      {explore}
    </div>
  );
}
