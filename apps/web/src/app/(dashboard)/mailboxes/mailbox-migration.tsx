"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState } from "react";
import {
  type ApplyResult,
  applicableItems,
  type DiscoveredAddress,
  defaultPlan,
  domainOf,
  groupByDomain,
  MIGRATION_PROVIDERS,
  type MigrationProviderId,
  type MigrationStatus,
  type MxDomainReadiness,
  type PlanItem,
  type PlanOutcome,
  type PlanSummary,
  planSummary,
  providerPreset,
  recentlyUsed,
  type TeamDomain,
  type TeamMailbox,
  toDate,
} from "@/lib/mailbox-migration";
import { createMigrationApi, type MigrationApi } from "@/lib/mailbox-migration-api";
import { useTRPCClient } from "@/lib/trpc";
import styles from "./mailbox-migration.module.css";

const STEPS = ["source", "addresses", "mx", "history"] as const;
type Step = (typeof STEPS)[number];

export type MailboxMigrationProps = {
  mailboxes: TeamMailbox[];
  domains: TeamDomain[];
  members: { id: string; name: string; email: string }[];
  currentUserId: string;
  /** Free mailbox seats on the license; null when unlimited. */
  seatsAvailable: number | null;
  /** Existing aliases per mailbox id, when known. */
  aliasCounts?: Record<string, number>;
  /** Called after `apply` created something, so the registry can refresh. */
  onApplied?: () => void;
};

type ConnectError = "login" | "network" | "reconnect" | "generic";

function connectFailure(cause: unknown): ConnectError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { data?: { code?: string; reason?: string } })?.data?.reason;
  if (code === "login" || /login|auth|credential/i.test(message)) return "login";
  if (code === "network" || /network|ECONN|timeout|unreach/i.test(message)) return "network";
  return "generic";
}

/**
 * The migration assistant: connect an account hosted elsewhere, pick which
 * of its addresses become mailboxes or aliases here, check each domain is
 * ready for its MX switch, and (next) bring the message history over.
 */
export function MailboxMigration({
  mailboxes,
  domains,
  members,
  currentUserId,
  seatsAvailable,
  aliasCounts = {},
  onApplied,
}: MailboxMigrationProps) {
  const t = useTranslations("mailboxes.migration");
  const format = useFormatter();
  const client = useTRPCClient();
  const api = useMemo<MigrationApi>(() => createMigrationApi(client), [client]);
  const id = useId();

  const [step, setStep] = useState<Step>("source");
  const [provider, setProvider] = useState<MigrationProviderId>("purelymail");
  const [host, setHost] = useState(providerPreset("purelymail").host);
  const [port, setPort] = useState(String(providerPreset("purelymail").port));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<ConnectError | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["mailbox-migration", "status", sourceId],
    queryFn: () => api.status(sourceId as string),
    enabled: sourceId !== null,
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      return phase === "connected" || phase === "scanning" ? 2000 : false;
    },
  });
  const scan: MigrationStatus | undefined = status.data;

  // The plan: one row per discovered address, seeded once per scan.
  const [plan, setPlan] = useState<Map<string, PlanItem>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [seededFor, setSeededFor] = useState<string | null>(null);
  useEffect(() => {
    if (scan?.phase !== "scanned" || seededFor === scan.sourceId) return;
    const seed = defaultPlan(scan.addresses, mailboxes, currentUserId);
    setPlan(new Map(seed.items.map((item) => [item.address, item])));
    setSelected(new Set(seed.selected));
    setSeededFor(scan.sourceId);
  }, [scan, seededFor, mailboxes, currentUserId]);

  const items = useMemo(() => [...plan.values()], [plan]);
  const preview = useMemo(
    () =>
      scan
        ? planSummary(items, selected, {
            addresses: scan.addresses,
            mailboxes,
            domains,
            aliasCounts,
            seatsAvailable,
          })
        : null,
    [scan, items, selected, mailboxes, domains, aliasCounts, seatsAvailable],
  );
  const [serverPlan, setServerPlan] = useState<PlanSummary | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(false);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  // The preview covers every row; the server's verdict overrides the rows it judged.
  const outcomes = useMemo(() => {
    const map = new Map(preview?.results.map((result) => [result.address, result.outcome]) ?? []);
    for (const result of serverPlan?.results ?? []) map.set(result.address, result.outcome);
    return map;
  }, [serverPlan, preview]);

  const readiness = useQuery({
    queryKey: ["mailbox-migration", "mx", sourceId],
    queryFn: () => api.mxReadiness(sourceId as string),
    enabled: sourceId !== null && step === "mx",
  });

  function choose(next: MigrationProviderId) {
    setProvider(next);
    const preset = providerPreset(next);
    if (preset.host) setHost(preset.host);
    setPort(String(preset.port));
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setConnecting(true);
    setConnectError(null);
    try {
      const source = await api.connect({
        provider,
        host: host.trim(),
        port: Number(port) || 993,
        secure: true,
        username: username.trim(),
        password,
      });
      setPassword("");
      setSourceId(source.sourceId);
      setSeededFor(null);
      setServerPlan(null);
      setApplied(null);
      setStep("addresses");
    } catch (cause) {
      setConnectError(connectFailure(cause));
    } finally {
      setConnecting(false);
    }
  }

  function update(address: string, patch: Partial<PlanItem>) {
    setServerPlan(null);
    setPlan((current) => {
      const next = new Map(current);
      const item = next.get(address);
      if (item) next.set(address, { ...item, ...patch });
      return next;
    });
  }

  function select(address: string, on: boolean) {
    setServerPlan(null);
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(address);
      else next.delete(address);
      return next;
    });
  }

  function selectWhere(predicate: (entry: DiscoveredAddress) => boolean) {
    if (!scan) return;
    setServerPlan(null);
    setSelected(
      new Set(
        scan.addresses
          .filter((entry) => !entry.inMepMail && predicate(entry))
          .map((e) => e.address),
      ),
    );
  }

  async function apply() {
    if (!sourceId || !preview) return;
    setApplying(true);
    setApplyError(false);
    try {
      const chosen = items.filter((item) => selected.has(item.address) && item.action !== "ignore");
      const verdict = await api.plan(sourceId, chosen);
      setServerPlan(verdict);
      const accepted = applicableItems(chosen, verdict);
      const refused = verdict.results.some(
        (result) => result.outcome !== "ok" && result.outcome !== "exists",
      );
      if (refused && !serverPlan) return; // first pass: show the verdict, apply on the next click
      if (!accepted.length) return;
      const result = await api.apply(sourceId, accepted);
      setApplied(result);
      onApplied?.();
      setStep("mx");
    } catch {
      setApplyError(true);
    } finally {
      setApplying(false);
    }
  }

  const groups = useMemo(() => (scan ? groupByDomain(scan.addresses) : []), [scan]);
  const domainNames = useMemo(() => new Set(domains.map((d) => d.name.toLowerCase())), [domains]);
  const now = useMemo(() => new Date(), []);
  const stepIndex = STEPS.indexOf(step);
  const canApply = !!preview && (preview.newMailboxes > 0 || preview.newAliases > 0) && !applying;
  const refusedCount = serverPlan
    ? serverPlan.results.filter((r) => r.outcome !== "ok" && r.outcome !== "exists").length
    : 0;
  const acceptedCount = serverPlan
    ? serverPlan.results.filter((r) => r.outcome === "ok").length
    : 0;

  return (
    <section className={styles.assistant} aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`}>{t("title")}</h3>
        <p className="ms-meta-tall">{t("hint")}</p>
      </div>
      <ol className={styles.steps} aria-label={t("stepsLabel")}>
        {STEPS.map((name, index) => (
          <li
            key={name}
            aria-current={name === step ? "step" : undefined}
            data-complete={index < stepIndex ? "true" : undefined}
          >
            <span aria-hidden="true" className={styles.stepNumber}>
              {index + 1}
            </span>
            {t(`steps.${name}`)}
          </li>
        ))}
      </ol>

      {step === "source" ? (
        <form className={styles.form} onSubmit={connect}>
          <fieldset className={styles.providers}>
            <legend>{t("provider")}</legend>
            {MIGRATION_PROVIDERS.map((entry) => (
              <label key={entry.id}>
                <input
                  type="radio"
                  name={`${id}-provider`}
                  value={entry.id}
                  checked={provider === entry.id}
                  onChange={() => choose(entry.id)}
                />
                {t(`providers.${entry.id}`)}
              </label>
            ))}
          </fieldset>
          <div className={styles.fields}>
            <div className={styles.hostRow}>
              <label>
                {t("host")}
                <input
                  className="ms-input"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                {t("port")}
                <input
                  className="ms-input"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              {t("username")}
              <input
                className="ms-input"
                type="email"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label>
              {t("password")}
              <input
                className="ms-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
              <small className="ms-meta-tall">
                {providerPreset(provider).appPassword ? t("appPasswordHint") : t("passwordHint")}
              </small>
            </label>
          </div>
          {connectError ? <p role="alert">{t(`errors.${connectError}`)}</p> : null}
          <div className={styles.actions}>
            <button type="submit" className="ms-btn ms-btn-primary" disabled={connecting}>
              {connecting ? t("connecting") : t("connect")}
            </button>
          </div>
        </form>
      ) : null}

      {step === "addresses" ? (
        status.isError ? (
          <div role="alert">
            <p>{t("statusError")}</p>
            <button type="button" className="ms-btn" onClick={() => void status.refetch()}>
              {t("mx.refresh")}
            </button>
          </div>
        ) : !scan || scan.phase === "connected" || scan.phase === "scanning" ? (
          <div className={styles.progress} aria-live="polite">
            <span>
              {scan
                ? t("scanning", {
                    done: scan.foldersDone,
                    total: scan.foldersTotal,
                    messages: scan.messagesSeen,
                  })
                : t("loading")}
            </span>
            <progress value={scan?.foldersDone ?? 0} max={Math.max(scan?.foldersTotal ?? 1, 1)} />
          </div>
        ) : scan.phase === "failed" ? (
          <div role="alert">
            <p>{t(`errors.${scan.failure ?? "generic"}`)}</p>
            <button type="button" className="ms-btn" onClick={() => setStep("source")}>
              {t("restart")}
            </button>
          </div>
        ) : (
          <>
            <p className="ms-meta-tall" aria-live="polite">
              {t("found", { count: scan.addresses.length, domains: groups.length })}
              {scan.truncated ? ` ${t("truncated")}` : ""}
            </p>
            <div className={styles.toolbar}>
              <button
                type="button"
                className="ms-btn ms-btn-ghost ms-btn-sm"
                onClick={() => selectWhere((entry) => recentlyUsed(entry, now))}
              >
                {t("selectRecent")}
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-ghost ms-btn-sm"
                onClick={() => selectWhere(() => true)}
              >
                {t("selectAll")}
              </button>
              <button
                type="button"
                className="ms-btn ms-btn-ghost ms-btn-sm"
                onClick={() => selectWhere(() => false)}
              >
                {t("selectNone")}
              </button>
            </div>
            <div className={styles.groups}>
              {groups.map((group) => (
                <section key={group.domain} className={styles.group} aria-label={group.domain}>
                  <header className={styles.groupHeader}>
                    <strong>{group.domain}</strong>
                    <small>
                      {t("messages", { count: group.messages })}
                      {group.lastSeenAt
                        ? ` · ${t("lastSeen", { date: format.dateTime(group.lastSeenAt, { dateStyle: "medium" }) })}`
                        : ""}
                    </small>
                  </header>
                  {!domainNames.has(group.domain) ? (
                    <p className={styles.groupNotice}>{t("domainMissingHint")}</p>
                  ) : null}
                  <ul className={styles.rows}>
                    {group.addresses.map((entry) => {
                      const item = plan.get(entry.address);
                      const on = selected.has(entry.address);
                      const outcome = outcomes.get(entry.address);
                      const seen = toDate(entry.lastSeenAt);
                      const targets = mailboxes.filter(
                        (box) => domainOf(box.address) === group.domain,
                      );
                      return (
                        <li
                          key={entry.address}
                          className={styles.row}
                          data-selected={entry.inMepMail ? "true" : String(on)}
                        >
                          <input
                            type="checkbox"
                            className="ms-checkbox"
                            aria-label={t("selectAddress", { address: entry.address })}
                            checked={entry.inMepMail ? true : on}
                            disabled={!!entry.inMepMail}
                            onChange={(event) => select(entry.address, event.target.checked)}
                          />
                          <div className={styles.rowMain}>
                            <span>{entry.address}</span>
                            <small className={styles.rowMeta}>
                              {t("messages", { count: entry.messages })}
                              {seen
                                ? ` · ${t("lastSeen", { date: format.dateTime(seen, { dateStyle: "medium" }) })}`
                                : ` · ${t("never")}`}
                              {entry.inMepMail ? ` · ${t(`existing.${entry.inMepMail}`)}` : ""}
                            </small>
                          </div>
                          {!entry.inMepMail && item ? (
                            <div className={styles.rowControls}>
                              <label>
                                {t("action.label")}
                                <select
                                  className="ms-input"
                                  value={item.action}
                                  onChange={(event) =>
                                    update(entry.address, {
                                      action: event.target.value as PlanItem["action"],
                                      mailboxId:
                                        event.target.value === "alias"
                                          ? (item.mailboxId ?? targets[0]?.id ?? null)
                                          : item.mailboxId,
                                    })
                                  }
                                >
                                  <option value="mailbox">{t("action.mailbox")}</option>
                                  <option value="alias" disabled={!targets.length}>
                                    {t("action.alias")}
                                  </option>
                                  <option value="ignore">{t("action.ignore")}</option>
                                </select>
                              </label>
                              {item.action === "alias" ? (
                                <label>
                                  {t("aliasTarget")}
                                  <select
                                    className="ms-input"
                                    value={item.mailboxId ?? ""}
                                    onChange={(event) =>
                                      update(entry.address, {
                                        mailboxId: event.target.value || null,
                                      })
                                    }
                                  >
                                    {targets.map((box) => (
                                      <option key={box.id} value={box.id}>
                                        {box.address}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ) : null}
                              {item.action === "mailbox" ? (
                                <>
                                  <label>
                                    {t("mailboxLabel")}
                                    <input
                                      className="ms-input"
                                      value={item.label ?? ""}
                                      maxLength={80}
                                      onChange={(event) =>
                                        update(entry.address, { label: event.target.value })
                                      }
                                    />
                                  </label>
                                  <label>
                                    {t("owner")}
                                    <select
                                      className="ms-input"
                                      value={item.ownerUserId ?? currentUserId}
                                      onChange={(event) =>
                                        update(entry.address, { ownerUserId: event.target.value })
                                      }
                                    >
                                      {members.map((member) => (
                                        <option key={member.id} value={member.id}>
                                          {member.name} ({member.email})
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                          {outcome && outcomeTone(outcome) ? (
                            <span className={`ms-badge ms-badge-${outcomeTone(outcome)}`}>
                              {t(`outcome.${outcome}`)}
                            </span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
            {scan.externalByDomain.length ? (
              <details>
                <summary>{t("externalTitle")}</summary>
                <ul>
                  {scan.externalByDomain.map((entry) => (
                    <li key={entry.domain}>
                      {t("externalRow", { domain: entry.domain, count: entry.messages })}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className={styles.footer}>
              <div>
                <p>
                  {preview
                    ? t("summary", {
                        mailboxes: preview.newMailboxes,
                        aliases: preview.newAliases,
                      })
                    : null}
                  {preview && preview.licensesNeeded > 0
                    ? ` · ${t("licenses", { count: preview.licensesNeeded })}`
                    : ""}
                </p>
                {serverPlan && refusedCount ? <p role="status">{t("reviewFirst")}</p> : null}
                {applyError ? <p role="alert">{t("applyError")}</p> : null}
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="ms-btn ms-btn-ghost"
                  onClick={() => setStep("source")}
                >
                  {t("back")}
                </button>
                <button
                  type="button"
                  className="ms-btn ms-btn-primary"
                  disabled={!canApply}
                  onClick={() => void apply()}
                >
                  {applying
                    ? t("applying")
                    : serverPlan && refusedCount
                      ? t("applyAccepted", { count: acceptedCount })
                      : t("apply")}
                </button>
              </div>
            </div>
          </>
        )
      ) : null}

      {step === "mx" ? (
        <>
          {applied ? (
            <p className="ms-notice-strip ms-notice-strip-info" role="status">
              {t("applied", {
                created: applied.results.filter((r) => r.outcome.startsWith("created")).length,
                failed: applied.results.filter((r) => r.outcome === "failed").length,
              })}
            </p>
          ) : null}
          <div>
            <h4>{t("mx.title")}</h4>
            <p className="ms-meta-tall">{t("mx.hint")}</p>
          </div>
          {readiness.isError ? (
            <div role="alert">
              <p>{t("mx.loadError")}</p>
              <button type="button" className="ms-btn" onClick={() => void readiness.refetch()}>
                {t("mx.refresh")}
              </button>
            </div>
          ) : readiness.isPending ? (
            <p>{t("loading")}</p>
          ) : (
            <ul className={styles.mxList}>
              {readiness.data.domains.map((domain) => (
                <MxCard key={domain.domain} domain={domain} />
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => setStep("addresses")}
            >
              {t("back")}
            </button>
            <button type="button" className="ms-btn" onClick={() => void readiness.refetch()}>
              {t("mx.refresh")}
            </button>
            <button type="button" className="ms-btn" onClick={() => setStep("history")}>
              {t("next")}
            </button>
          </div>
        </>
      ) : null}

      {step === "history" ? (
        <>
          <div>
            <h4>{t("history.title")}</h4>
            <p className="ms-meta-tall">{t("history.soon")}</p>
          </div>
          <div className={styles.actions}>
            <button type="button" className="ms-btn ms-btn-ghost" onClick={() => setStep("mx")}>
              {t("back")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

function outcomeTone(outcome: PlanOutcome): "success" | "warn" | "danger" | "neutral" | null {
  switch (outcome) {
    case "ok":
    case "ignored":
      return null;
    case "exists":
      return "neutral";
    case "needs_license":
    case "over_alias_cap":
    case "domain_missing":
      return "warn";
    case "conflict":
    case "invalid":
      return "danger";
    default:
      return null;
  }
}

function MxCard({ domain }: { domain: MxDomainReadiness }) {
  const t = useTranslations("mailboxes.migration.mx");
  const ready = domain.pending.length === 0 && domain.recipients <= domain.recipientCap;
  const stateKey = (
    ["receiving", "needs_mx", "needs_dns", "needs_activation", "not_in_mepmail"] as const
  ).includes(
    domain.receivingState as
      | "receiving"
      | "needs_mx"
      | "needs_dns"
      | "needs_activation"
      | "not_in_mepmail",
  )
    ? (domain.receivingState as
        | "receiving"
        | "needs_mx"
        | "needs_dns"
        | "needs_activation"
        | "not_in_mepmail")
    : "unknown";
  return (
    <li className={styles.mxCard}>
      <header>
        <strong>{domain.domain}</strong>
        <span className={`ms-badge ms-badge-${ready ? "success" : "warn"}`}>
          {ready ? t("ready") : t("pending", { count: domain.pending.length })}
        </span>
      </header>
      {domain.pending.length ? (
        <ul>
          {domain.pending.map((address) => (
            <li key={address}>{address}</li>
          ))}
        </ul>
      ) : null}
      {domain.domainId ? (
        <span>{t("capacity", { used: domain.recipients, cap: domain.recipientCap })}</span>
      ) : null}
      {domain.recipients > domain.recipientCap ? (
        <span role="alert">{t("capWarning", { cap: domain.recipientCap })}</span>
      ) : null}
      <span>{t(`state.${stateKey}`)}</span>
      {domain.mx ? (
        <span className={styles.mono}>
          {t("record", { exchange: domain.mx.exchange, priority: domain.mx.priority })}
        </span>
      ) : null}
    </li>
  );
}
