"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { CloudflareSetup } from "@/app/(dashboard)/domains/cloudflare-setup";
import { type DomainStatus, DomainStatusBadge } from "@/app/(dashboard)/domains/domain-status";
import {
  type DnsRecord,
  DnsRecordsTable,
  DnsRecordsTableSkeleton,
} from "@/components/dns-records-table";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { useTRPC } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import styles from "./domain-first.module.css";
import {
  currentStep,
  type DnsProvider,
  type DomainRow,
  domainFromInput,
  type FlowStep,
  flowDomain,
  initialRegistrar,
  providerSlug,
  REGISTRAR_URLS,
  REGISTRARS,
  type Registrar,
  readSkipped,
  type SkippableStep,
  suggestedLocalPart,
  writeSkipped,
} from "./domain-first-model";
import { type OnboardingEvent, useOnboardingTrack } from "./onboarding-track";

/** domains.create errors that have their own sentence in the domains catalog. */
const CREATE_ERRORS = {
  CONFLICT: "new.conflict",
  BAD_REQUEST: "new.reserved",
  PRECONDITION_FAILED: "new.planLimit",
  TOO_MANY_REQUESTS: "new.rateLimited",
} as const;

/** While a domain waits for DNS the list is read again this often (the server checks on its own too). */
const PENDING_POLL_MS = 20_000;

type Track = (event: OnboardingEvent, detail?: string) => void;

/**
 * The first thing after naming the team: the person's own domain, its DNS
 * (one click on Cloudflare, a short guide per registrar elsewhere), the first
 * mailbox on it, then an agent. Every step can be put off; nothing here
 * blocks the dashboard or the API path below it.
 */
export function DomainFirst({ userEmail }: { userEmail: string }) {
  const t = useTranslations("onboarding.domainFirst");
  const trpc = useTRPC();
  const track = useOnboardingTrack();
  const [skipped, setSkipped] = useState<Set<SkippableStep>>(() => new Set());
  useEffect(() => setSkipped(readSkipped()), []);

  const domains = useQuery({
    ...trpc.domains.list.queryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some(
        (row) => row.status === "pending" || row.status === "temporary_failure",
      )
        ? PENDING_POLL_MS
        : false,
  });
  const domain = domains.data ? flowDomain(domains.data as DomainRow[]) : null;
  const capabilities = useQuery(trpc.mailboxes.capabilities.queryOptions());
  const mailboxes = useQuery(
    trpc.mailboxes.list.queryOptions(undefined, {
      enabled: capabilities.data?.enabled === true,
      retry: false,
    }),
  );
  const hasMailbox = (mailboxes.data?.mailboxes.length ?? 0) > 0;
  const step = currentStep({ domain, hasMailbox, skipped });

  useEffect(() => track("domain_viewed"), [track]);
  const verified = domain?.status === "verified";
  useEffect(() => {
    if (verified) track("domain_verified");
  }, [verified, track]);

  function setSkip(which: SkippableStep, on: boolean) {
    const next = new Set(skipped);
    if (on) next.add(which);
    else next.delete(which);
    setSkipped(next);
    writeSkipped(next);
    if (on) track(`skip_${which}`);
  }

  if (domains.isPending) {
    return (
      <div className={styles.flow}>
        <Skeleton width="60%" height={34} />
        <Skeleton width="100%" height={180} radius="var(--ms-r-card)" />
      </div>
    );
  }

  return (
    <div className={styles.flow}>
      <header className={styles.intro}>
        <h1 className="ms-display">{t("title")}</h1>
        <p>{t("subtitle")}</p>
      </header>
      <ol className={styles.steps}>
        <DomainStep
          domain={domain}
          active={step === "domain"}
          skipped={!domain && skipped.has("domain")}
          onSkip={() => setSkip("domain", true)}
          onResume={() => setSkip("domain", false)}
          track={track}
        />
        <DnsStep
          domain={domain}
          active={step === "dns"}
          skipped={!!domain && !verified && skipped.has("dns")}
          onSkip={() => setSkip("dns", true)}
          onResume={() => setSkip("dns", false)}
          track={track}
        />
        <MailboxStep
          domain={domain}
          step={step}
          hasMailbox={hasMailbox}
          skipped={!hasMailbox && skipped.has("mailbox")}
          onSkip={() => setSkip("mailbox", true)}
          onResume={() => setSkip("mailbox", false)}
          userEmail={userEmail}
          track={track}
        />
        <AgentStep active={step === "agent"} track={track} />
      </ol>
    </div>
  );
}

/** One numbered step: marker, title, one line, then what the step needs. */
function Step({
  marker,
  state,
  title,
  body,
  children,
}: {
  marker: string;
  state: "active" | "done" | "locked" | "skipped";
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={styles.step} data-state={state}>
      <span className={styles.marker} aria-hidden="true">
        {state === "done" ? "✓" : marker}
      </span>
      <section className={styles.card}>
        <h2>{title}</h2>
        <p className={styles.body}>{body}</p>
        {children}
      </section>
    </li>
  );
}

function DomainStep({
  domain,
  active,
  skipped,
  onSkip,
  onResume,
  track,
}: {
  domain: DomainRow | null;
  active: boolean;
  skipped: boolean;
  onSkip: () => void;
  onResume: () => void;
  track: Track;
}) {
  const t = useTranslations("onboarding.domainFirst");
  const domainsT = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inputId = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const features = useQuery(trpc.system.features.queryOptions());
  const served = features.data?.regions;
  // The same default as the add-domain form: a production region when there is one.
  const region = (served?.find((r) => r.production) ?? served?.[0])?.code ?? "";
  const create = useMutation(
    trpc.domains.create.mutationOptions({
      onSuccess: () => {
        track("domain_added");
        void queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
      },
    }),
  );
  const name = domainFromInput(value);
  const showInvalid = touched && value.trim() !== "" && !name;
  const code = create.isError ? trpcErrorCode(create.error) : null;
  const errorKey =
    code && code in CREATE_ERRORS ? CREATE_ERRORS[code as keyof typeof CREATE_ERRORS] : null;

  if (domain) {
    return (
      <Step marker="01" state="done" title={t("domain.title")} body={t("domain.body")}>
        <p className={styles.summary}>
          <span className="ms-mono">{domain.name}</span>
          <DomainStatusBadge status={domain.status as DomainStatus} />
        </p>
      </Step>
    );
  }
  if (skipped) {
    return (
      <Step marker="01" state="skipped" title={t("domain.title")} body={t("domain.skipped")}>
        <div className={styles.actions}>
          <button type="button" className="ms-btn ms-btn-primary" onClick={onResume}>
            {t("domain.resume")}
          </button>
        </div>
      </Step>
    );
  }
  return (
    <Step
      marker="01"
      state={active ? "active" : "locked"}
      title={t("domain.title")}
      body={t("domain.body")}
    >
      <form
        className={styles.domainForm}
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!name || create.isPending || region === "") return;
          create.mutate({ name, region, mailFromSubdomain: "send" });
        }}
      >
        <label htmlFor={inputId}>{t("domain.label")}</label>
        <div className={styles.inputRow}>
          <input
            id={inputId}
            className={`ms-input mono${showInvalid ? " error" : ""}`}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t("domain.placeholder")}
            value={value}
            disabled={create.isPending}
            aria-invalid={showInvalid}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={create.isPending || value.trim() === "" || region === ""}
          >
            <BtnSpinner on={create.isPending} />
            {t("domain.submit")}
          </button>
        </div>
        <p id={`${inputId}-hint`} className={showInvalid ? styles.error : styles.hint}>
          {showInvalid
            ? t("domain.invalid")
            : name && name !== value.trim().toLowerCase()
              ? name
              : t("domain.hint")}
        </p>
        {create.isError ? (
          <p className={styles.error} role="alert">
            {errorKey ? domainsT(errorKey) : create.error.message || domainsT("new.error")}
          </p>
        ) : null}
      </form>
      <div className={styles.actions}>
        <button type="button" className={styles.skip} onClick={onSkip}>
          {t("skip")}
        </button>
      </div>
    </Step>
  );
}

function DnsStep({
  domain,
  active,
  skipped,
  onSkip,
  onResume,
  track,
}: {
  domain: DomainRow | null;
  active: boolean;
  skipped: boolean;
  onSkip: () => void;
  onResume: () => void;
  track: Track;
}) {
  const t = useTranslations("onboarding.domainFirst");
  const verified = domain?.status === "verified";
  if (!domain) {
    return <Step marker="02" state="locked" title={t("dns.title")} body={t("dns.locked")} />;
  }
  if (verified) {
    return (
      <Step
        marker="02"
        state="done"
        title={t("dns.title")}
        body={t("dns.verified", { domain: domain.name })}
      />
    );
  }
  if (skipped) {
    return (
      <Step marker="02" state="skipped" title={t("dns.title")} body={t("dns.skipped")}>
        <div className={styles.actions}>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onResume}>
            {t("dns.verify")}
          </button>
        </div>
      </Step>
    );
  }
  return (
    <Step
      marker="02"
      state={active ? "active" : "locked"}
      title={t("dns.title")}
      body={t("dns.body")}
    >
      <DnsGuide domain={domain} onSkip={onSkip} track={track} />
    </Step>
  );
}

function DnsGuide({
  domain,
  onSkip,
  track,
}: {
  domain: DomainRow;
  onSkip: () => void;
  track: Track;
}) {
  const t = useTranslations("onboarding.domainFirst");
  const domainsT = useTranslations("domains");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const records = useQuery(trpc.domains.records.queryOptions({ id: domain.id }));
  const provider: DnsProvider = records.data?.provider ?? null;
  const slug = providerSlug(provider);
  const [chosen, setChosen] = useState<Registrar | null>(null);
  const registrar = chosen ?? initialRegistrar(provider);
  const [checked, setChecked] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.domains.list.queryKey() });
    void queryClient.invalidateQueries({
      queryKey: trpc.domains.records.queryKey({ id: domain.id }),
    });
  };
  const verify = useMutation(
    trpc.domains.verify.mutationOptions({
      onSettled: () => {
        setChecked(true);
        refresh();
      },
    }),
  );

  const reported = useRef(false);
  useEffect(() => {
    if (!records.isSuccess || reported.current) return;
    reported.current = true;
    track("dns_provider", slug);
  }, [records.isSuccess, slug, track]);

  const recordsBlock = records.isError ? (
    <div className={styles.actions}>
      <p className={styles.hint}>{domainsT("detail.recordsError")}</p>
      <button type="button" className="ms-btn ms-btn-secondary" onClick={() => records.refetch()}>
        {domainsT("detail.retry")}
      </button>
    </div>
  ) : records.isSuccess ? (
    <DnsRecordsTable
      records={records.data.records as DnsRecord[]}
      domain={domain.name}
      showStatus
    />
  ) : (
    <DnsRecordsTableSkeleton showStatus />
  );

  const guide = (
    <div className={styles.guide}>
      <fieldset className={styles.registrars}>
        <legend>{t("dns.where")}</legend>
        {REGISTRARS.map((key) => (
          <label key={key} className={styles.registrar} data-selected={key === registrar}>
            <input
              type="radio"
              name={`registrar-${domain.id}`}
              value={key}
              checked={key === registrar}
              onChange={() => {
                setChosen(key);
                track("guide_opened", key);
              }}
            />
            {t(`guides.${key}.name`)}
          </label>
        ))}
      </fieldset>
      <ol className={styles.guideSteps}>
        {(t.raw(`guides.${registrar}.steps`) as string[]).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      {registrar !== "other" ? (
        <a
          className="ms-btn ms-btn-secondary"
          href={provider?.url && slug === registrar ? provider.url : REGISTRAR_URLS[registrar]}
          target="_blank"
          rel="noreferrer"
        >
          {t("dns.open", { provider: t(`guides.${registrar}.name`) })} ↗
        </a>
      ) : provider?.url ? (
        <a className="ms-btn ms-btn-secondary" href={provider.url} target="_blank" rel="noreferrer">
          {t("dns.open", { provider: provider.name })} ↗
        </a>
      ) : null}
      <p className={styles.recordsLabel}>{t("dns.records")}</p>
      {recordsBlock}
    </div>
  );

  return (
    <>
      {records.isSuccess ? (
        <p className={styles.detected}>
          {provider
            ? t("dns.detected", { domain: domain.name, provider: provider.name })
            : t("dns.unknown", { domain: domain.name })}
        </p>
      ) : null}
      {slug === "cloudflare" ? (
        <>
          <CloudflareSetup
            id={domain.id}
            domainName={domain.name}
            onOpen={() => track("cloudflare_opened")}
            onConfigured={() => {
              track("cloudflare_configured");
              refresh();
            }}
          />
          <details className={styles.manual}>
            <summary>{t("dns.manual")}</summary>
            {guide}
          </details>
        </>
      ) : (
        guide
      )}
      {checked && domain.status !== "verified" ? (
        <p className={styles.status} role="status">
          {domain.status === "failed" ? t("dns.failed", { domain: domain.name }) : t("dns.pending")}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          disabled={verify.isPending}
          onClick={() => {
            track("verify_clicked");
            verify.mutate({ id: domain.id });
          }}
        >
          <BtnSpinner on={verify.isPending} />
          {verify.isPending ? t("dns.verifying") : t("dns.verify")}
        </button>
        <button type="button" className={styles.skip} onClick={onSkip}>
          {t("dns.later")}
        </button>
        <Link href="/support#chat" className={styles.help}>
          {t("help")}
        </Link>
      </div>
    </>
  );
}

function MailboxStep({
  domain,
  step,
  hasMailbox,
  skipped,
  onSkip,
  onResume,
  userEmail,
  track,
}: {
  domain: DomainRow | null;
  step: FlowStep;
  hasMailbox: boolean;
  skipped: boolean;
  onSkip: () => void;
  onResume: () => void;
  userEmail: string;
  track: Track;
}) {
  const t = useTranslations("onboarding.domainFirst");
  if (hasMailbox) {
    return (
      <Step marker="03" state="done" title={t("mailbox.title")} body={t("mailbox.done")}>
        <div className={styles.actions}>
          <Link href="/mail" className="ms-btn ms-btn-secondary">
            {t("mailbox.open")}
          </Link>
        </div>
      </Step>
    );
  }
  if (!domain || step === "domain" || step === "dns") {
    return (
      <Step marker="03" state="locked" title={t("mailbox.title")} body={t("mailbox.locked")} />
    );
  }
  const local = suggestedLocalPart(userEmail);
  const address = `${local}@${domain.name}`;
  if (skipped) {
    return (
      <Step marker="03" state="skipped" title={t("mailbox.title")} body={t("mailbox.skipped")}>
        <div className={styles.actions}>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onResume}>
            {t("mailbox.cta", { address })}
          </button>
        </div>
      </Step>
    );
  }
  const href = `/mail?${new URLSearchParams({ new: "1", domain: domain.id, local })}`;
  return (
    <Step
      marker="03"
      state="active"
      title={t("mailbox.title")}
      body={t("mailbox.body", { address })}
    >
      <div className={styles.actions}>
        <Link
          href={href}
          className="ms-btn ms-btn-primary"
          onClick={() => track("mailbox_clicked")}
        >
          {t("mailbox.cta", { address })}
        </Link>
        <button type="button" className={styles.skip} onClick={onSkip}>
          {t("skip")}
        </button>
      </div>
    </Step>
  );
}

function AgentStep({ active, track }: { active: boolean; track: Track }) {
  const t = useTranslations("onboarding.domainFirst");
  if (!active) {
    return <Step marker="04" state="locked" title={t("agent.title")} body={t("agent.locked")} />;
  }
  return (
    <Step marker="04" state="active" title={t("agent.title")} body={t("agent.body")}>
      <div className={styles.actions}>
        <Link
          href="/mail/settings?tab=agents"
          className="ms-btn ms-btn-secondary"
          onClick={() => track("agent_clicked")}
        >
          {t("agent.cta")}
        </Link>
      </div>
    </Step>
  );
}
