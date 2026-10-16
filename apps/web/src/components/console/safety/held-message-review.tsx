"use client";

import type { RevealSpan } from "@millionsend/core/content-reveal";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { formatDayTime, formatMmSs } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";
import { useCountdown } from "@/lib/use-countdown";

const MIN_JUSTIFICATION = 20;
const MAX_JUSTIFICATION = 1_000;
const REASONS = ["payment_risk_review", "phishing_or_malware", "provider_report"] as const;
type Reason = (typeof REASONS)[number];
type Access = { operationId: string; expiresAt: Date; state: "pending" | "ready" };
type Content = {
  subject: RevealSpan[];
  spans: RevealSpan[];
  expiresAt: Date;
  redactions: number;
  linkHosts: string[];
};

/** Content reads are explicit actions; focus, network recovery and retries never add a view. */
export const HELD_REVIEW_QUERY_POLICY = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
  refetchInterval: false,
} as const;

// Kept local to this narrowly scoped screen; the production content-reveal copy is unchanged.
export const HELD_REVIEW_COPY = {
  "pt-BR": {
    entryTitle: "Revisão de mensagem retida",
    entryLead:
      "Consulte o conteúdo por uma revisão interna auditada. A revisão mantém a mensagem retida e não libera nem envia e-mails.",
    entryAction: "Revisar mensagem retida",
    title: "Revisão interna da mensagem retida",
    back: "Revisão da equipe",
    lead: "Esta consulta é auditada. A mensagem permanece retida e a equipe permanece bloqueada para envio.",
    loading: "Consultando disponibilidade da revisão…",
    unavailable: "A revisão interna está indisponível neste ambiente ou para esta mensagem.",
    missing:
      "Esta mensagem não está disponível para revisão. Ela pode não estar mais retida ou seu conteúdo pode ter sido removido pela retenção.",
    failed: "Não foi possível consultar a revisão. Tente novamente.",
    check: "Verificar disponibilidade",
    message: "Mensagem",
    created: "Aceita em",
    held: "Retida · não enviada",
    request: "Solicitar revisão desta mensagem",
    pending:
      "Solicitação registrada na auditoria. Aguarde a preparação da revisão e verifique a disponibilidade manualmente.",
    ready: "A revisão está pronta para consulta durante a janela autorizada.",
    open: "Abrir revisão",
    expired: "A janela de revisão expirou. Solicite uma nova revisão para consultar o conteúdo.",
    dialogTitle: "Solicitar revisão da mensagem retida",
    reason: "Motivo da revisão",
    reasons: {
      payment_risk_review: "Revisão de risco de pagamento",
      phishing_or_malware: "Suspeita de phishing ou malware",
      provider_report: "Denúncia de abuso de um provedor",
    },
    why: "Justificativa",
    whyHelp:
      "Explique por que a consulta é necessária, de 20 a 1.000 caracteres. Não inclua credenciais nem copie o conteúdo da mensagem.",
    whyError: "Informe uma justificativa entre 20 e 1.000 caracteres.",
    scope:
      "Somente esta mensagem. O motivo, a justificativa e as consultas ficam registrados na auditoria interna.",
    confirm: "Registrar solicitação de revisão",
    requestFailed:
      "Não foi possível registrar a solicitação. Verifique a disponibilidade antes de tentar novamente.",
    cancel: "Cancelar",
    close: "Encerrar revisão",
    contentTitle: "Conteúdo para revisão interna",
    contentLoading: "Abrindo conteúdo para revisão…",
    contentFailed: "Não foi possível abrir o conteúdo. Verifique a disponibilidade da revisão.",
    rendered: "Somente texto · dados sensíveis ocultados",
    subject: "Assunto",
    body: "Texto da mensagem",
    empty: "Nenhum texto disponível.",
    hosts: "Domínios encontrados nos links · somente texto",
    noMonitor:
      "Sem julgamento do monitor. A ausência de um julgamento não indica que a mensagem é segura.",
    expiry: "Expira em",
    audit:
      "As consultas autorizadas ficam registradas na auditoria interna. A leitura não altera a retenção nem a situação da equipe.",
  },
  en: {
    entryTitle: "Held message review",
    entryLead:
      "Access the content through an audited internal review. The review keeps the message held and does not release or send emails.",
    entryAction: "Review held message",
    title: "Internal review of a held message",
    back: "Team review",
    lead: "This access is audited. The message remains held and the team remains blocked from sending.",
    loading: "Checking review availability…",
    unavailable: "Internal review is unavailable in this environment or for this message.",
    missing:
      "This message is unavailable for review. It may no longer be held or its content may have been removed by retention.",
    failed: "The review could not be checked. Try again.",
    check: "Check availability",
    message: "Message",
    created: "Accepted at",
    held: "Held · not sent",
    request: "Request review of this message",
    pending:
      "The request is recorded in the audit log. Wait for the review to be prepared, then check availability manually.",
    ready: "The review is ready to open within the authorized window.",
    open: "Open review",
    expired: "The review window has expired. Request a new review to access the content.",
    dialogTitle: "Request review of the held message",
    reason: "Reason for review",
    reasons: {
      payment_risk_review: "Payment risk review",
      phishing_or_malware: "Suspected phishing or malware",
      provider_report: "Provider abuse report",
    },
    why: "Justification",
    whyHelp:
      "Explain why access is needed in 20 to 1,000 characters. Do not include credentials or copy message content.",
    whyError: "Provide a justification between 20 and 1,000 characters.",
    scope:
      "This message only. The reason, justification and views are recorded in the internal audit log.",
    confirm: "Record review request",
    requestFailed: "The request could not be recorded. Check availability before trying again.",
    cancel: "Cancel",
    close: "End review",
    contentTitle: "Content for internal review",
    contentLoading: "Opening review content…",
    contentFailed: "The content could not be opened. Check review availability.",
    rendered: "Text only · sensitive data hidden",
    subject: "Subject",
    body: "Message text",
    empty: "No text available.",
    hosts: "Domains found in links · text only",
    noMonitor: "No monitor verdict. The absence of a verdict does not mean the message is safe.",
    expiry: "Expires in",
    audit:
      "Authorized views are recorded in the internal audit log. Reading does not change the hold or the team's standing.",
  },
} as const;

function copyFor(locale: string) {
  return HELD_REVIEW_COPY[locale === "pt-BR" ? "pt-BR" : "en"];
}

/** Metadata-only entry point; the dedicated review page owns every access action. */
export function HeldMessageReviewEntry({ teamId }: { teamId: string }) {
  const locale = useLocale();
  const copy = copyFor(locale);
  const titleId = useId();
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.console.heldReview.status.queryOptions({ teamId }),
    ...HELD_REVIEW_QUERY_POLICY,
  });
  if (query.isPending || query.isError || !query.data?.enabled || !query.data.message) return null;
  const href = `/console/safety/${encodeURIComponent(teamId)}/held/${encodeURIComponent(query.data.message.id)}`;
  return (
    <section
      className="ms-card"
      style={{ padding: 20, marginBottom: 16 }}
      aria-labelledby={titleId}
    >
      <h2
        id={titleId}
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
      >
        {copy.entryTitle}
      </h2>
      <p style={{ color: "var(--ms-muted)", fontSize: 13 }}>{copy.entryLead}</p>
      <Link href={href} className="ms-btn ms-btn-secondary">
        {copy.entryAction}
      </Link>
    </section>
  );
}

export function HeldMessageReview({ teamId, emailId }: { teamId: string; emailId: string }) {
  const locale = useLocale();
  const copy = copyFor(locale);
  const trpc = useTRPC();
  const query = useQuery({
    ...trpc.console.heldReview.status.queryOptions({ teamId }),
    ...HELD_REVIEW_QUERY_POLICY,
  });
  const [accessOverride, setAccessOverride] = useState<Access | null | undefined>();
  const [requestOpen, setRequestOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const requestButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const access = accessOverride === undefined ? query.data?.access : accessOverride;
  const left = useCountdown(access?.expiresAt ?? null);
  const message = query.data?.message?.id === emailId ? query.data.message : null;
  const matches = query.data?.enabled && message !== null;
  const request = useMutation({
    ...trpc.console.heldReview.requestAccess.mutationOptions(),
    retry: false,
  });

  const check = async () => {
    const result = await query.refetch();
    if (result.data && !result.isError) {
      setAccessOverride(result.data.access);
      setRequestError(false);
    }
  };
  const closeRequest = () => {
    setRequestOpen(false);
    requestButton.current?.focus();
  };

  return (
    <>
      <PageHeader
        title={copy.title}
        subtitle={copy.lead}
        breadcrumb={
          <>
            <Crumb href={`/console/safety/${encodeURIComponent(teamId)}`} label={copy.back} />
            <CrumbEnd label={copy.title} />
          </>
        }
      />
      <section className="ms-card" style={{ padding: 20 }} aria-busy={query.isFetching}>
        {query.isPending ? (
          <p role="status">{copy.loading}</p>
        ) : query.isError ? (
          <p role="alert">{copy.failed}</p>
        ) : !query.data.enabled ? (
          <p role="status">{copy.unavailable}</p>
        ) : !matches || !message ? (
          <p role="status">{copy.missing}</p>
        ) : (
          <>
            <dl className="ms-grid ms-grid-2" style={{ margin: "0 0 16px" }}>
              <div>
                <dt className="ms-microlabel">{copy.message}</dt>
                <dd style={{ margin: "6px 0" }} className="ms-mono">
                  {emailId.slice(0, 8)}
                </dd>
              </div>
              <div>
                <dt className="ms-microlabel">{copy.created}</dt>
                <dd style={{ margin: "6px 0" }}>{formatDayTime(message.createdAt, locale)}</dd>
              </div>
            </dl>
            <span className="ms-badge ms-badge-warn">{copy.held}</span>
            <p role="status" style={{ marginTop: 14 }}>
              {access && left === 0
                ? copy.expired
                : access?.state === "ready"
                  ? copy.ready
                  : access
                    ? copy.pending
                    : copy.scope}
            </p>
            {access && left > 0 ? (
              <p>
                {copy.expiry} <span className="ms-digits">{formatMmSs(left)}</span>
              </p>
            ) : null}
            {access?.state === "ready" && left > 0 ? (
              <button
                ref={openButton}
                type="button"
                className="ms-btn ms-btn-primary"
                onClick={() => setContentOpen(true)}
              >
                {copy.open}
              </button>
            ) : !access || left === 0 ? (
              <button
                ref={requestButton}
                type="button"
                className="ms-btn ms-btn-primary"
                onClick={() => {
                  setRequestError(false);
                  setRequestOpen(true);
                }}
              >
                {copy.request}
              </button>
            ) : null}
          </>
        )}
        {!query.isPending ? (
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 16 }}
            disabled={query.isFetching || request.isPending}
            onClick={() => void check()}
          >
            <BtnSpinner on={query.isFetching} />
            {copy.check}
          </button>
        ) : null}
      </section>
      {requestOpen && matches ? (
        <HeldReviewRequestDialog
          locale={locale}
          pending={request.isPending}
          error={requestError}
          onClose={closeRequest}
          onSubmit={(values) => {
            setRequestError(false);
            request.mutate(
              { teamId, emailId, ...values },
              {
                onSuccess: (result) => {
                  setAccessOverride({ ...result, state: "pending" });
                  closeRequest();
                },
                onError: () => setRequestError(true),
              },
            );
          }}
        />
      ) : null}
      {contentOpen && matches && access ? (
        <HeldReviewContentDialog
          teamId={teamId}
          emailId={emailId}
          access={access}
          onClose={() => {
            setContentOpen(false);
            openButton.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

export function HeldReviewRequestDialog({
  locale,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  locale: string;
  pending: boolean;
  error: boolean;
  onClose: () => void;
  onSubmit: (values: { reason: Reason; justification: string }) => void;
}) {
  const copy = copyFor(locale);
  const id = useId();
  const [reason, setReason] = useState<Reason>("payment_risk_review");
  const [justification, setJustification] = useState("");
  const [attempted, setAttempted] = useState(false);
  const length = justification.trim().length;
  const invalid = length < MIN_JUSTIFICATION || length > MAX_JUSTIFICATION;
  const showError = invalid && (attempted || justification.length > 0);
  const submit = () => {
    setAttempted(true);
    if (!pending && !invalid) onSubmit({ reason, justification: justification.trim() });
  };
  return (
    <Modal open title={copy.dialogTitle} onClose={onClose} onConfirm={submit}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        aria-busy={pending}
      >
        <p>{copy.lead}</p>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-reason`}>{copy.reason}</label>
          <Select
            id={`${id}-reason`}
            value={reason}
            onChange={(value) => setReason(value as Reason)}
            ariaLabel={copy.reason}
            width="100%"
            disabled={pending}
            options={REASONS.map((value) => ({ value, label: copy.reasons[value] }))}
          />
        </div>
        <div className="ms-field" style={{ marginBottom: 14 }}>
          <label htmlFor={`${id}-why`}>{copy.why}</label>
          <textarea
            id={`${id}-why`}
            className="ms-input"
            style={{ width: "100%", minHeight: 100, resize: "vertical" }}
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
            maxLength={MAX_JUSTIFICATION}
            disabled={pending}
            required
            aria-invalid={showError}
            aria-describedby={`${id}-help${showError ? ` ${id}-error` : ""}`}
          />
          <p id={`${id}-help`} style={{ fontSize: 13, color: "var(--ms-muted)" }}>
            {copy.whyHelp}
          </p>
          {showError ? (
            <p id={`${id}-error`} role="alert" style={{ color: "var(--ms-danger)" }}>
              {copy.whyError}
            </p>
          ) : null}
        </div>
        <p>{copy.scope}</p>
        {error ? (
          <p role="alert" style={{ color: "var(--ms-danger)" }}>
            {copy.requestFailed}
          </p>
        ) : null}
        <ModalFooter>
          <button type="button" className="ms-btn ms-btn-secondary" onClick={onClose}>
            {copy.cancel}
          </button>
          <button type="submit" className="ms-btn ms-btn-primary" disabled={pending || invalid}>
            <BtnSpinner on={pending} />
            {copy.confirm}
            <ConfirmKeycap />
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function TextSpans({ spans }: { spans: RevealSpan[] }) {
  let offset = 0;
  return spans.map((span) => {
    const key = offset;
    offset += span.text.length;
    return (
      <span key={key} className={span.redacted ? "ms-redact" : undefined}>
        {span.text}
      </span>
    );
  });
}

/** Pure text rendering is also used by the UI tests: URLs and HTML never become active content. */
export function HeldReviewContent({ locale, content }: { locale: string; content: Content }) {
  const copy = copyFor(locale);
  return (
    <>
      <p className="ms-chip">{copy.rendered}</p>
      <h3 className="ms-microlabel">{copy.subject}</h3>
      <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
        <TextSpans spans={content.subject} />
      </div>
      <h3 className="ms-microlabel">{copy.body}</h3>
      <div className="ms-revealed" style={{ overflowWrap: "anywhere" }}>
        {content.spans.length ? <TextSpans spans={content.spans} /> : copy.empty}
      </div>
      {content.linkHosts.length ? (
        <>
          <h3 className="ms-microlabel">{copy.hosts}</h3>
          <ul>
            {content.linkHosts.map((host) => (
              <li key={host} className="ms-mono" style={{ overflowWrap: "anywhere" }}>
                {host}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p style={{ color: "var(--ms-muted)", fontSize: 13 }}>{copy.noMonitor}</p>
    </>
  );
}

function HeldReviewContentDialog({
  teamId,
  emailId,
  access,
  onClose,
}: {
  teamId: string;
  emailId: string;
  access: Access;
  onClose: () => void;
}) {
  const locale = useLocale();
  const copy = copyFor(locale);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = { teamId, emailId, operationId: access.operationId };
  const queryKey = trpc.console.heldReview.revealed.queryKey(input);
  const keyRef = useRef(queryKey);
  const [windowClosed, setWindowClosed] = useState(false);
  const grantLeft = useCountdown(access.expiresAt);
  const query = useQuery({
    ...trpc.console.heldReview.revealed.queryOptions(input),
    ...HELD_REVIEW_QUERY_POLICY,
    enabled: !windowClosed && grantLeft > 0,
  });
  const left = useCountdown(query.data?.expiresAt ?? access.expiresAt);
  const expired = windowClosed || grantLeft === 0 || left === 0;
  const clearContent = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: keyRef.current, exact: true });
    queryClient.removeQueries({ queryKey: keyRef.current, exact: true });
  }, [queryClient]);
  useEffect(() => clearContent, [clearContent]);
  useEffect(() => {
    if (expired) {
      setWindowClosed(true);
      clearContent();
    }
  }, [expired, clearContent]);

  return (
    <Modal
      open
      size="wide"
      title={copy.contentTitle}
      onClose={() => {
        clearContent();
        onClose();
      }}
    >
      <p>{copy.lead}</p>
      {expired ? (
        <p role="status">{copy.expired}</p>
      ) : query.isPending ? (
        <p role="status">{copy.contentLoading}</p>
      ) : query.isError ? (
        <p role="alert">{copy.contentFailed}</p>
      ) : (
        <>
          {/* Announce expiry once above, rather than reading a ticking countdown every second. */}
          <p>
            {copy.expiry} <span className="ms-digits">{formatMmSs(Math.min(left, grantLeft))}</span>
          </p>
          <HeldReviewContent locale={locale} content={query.data} />
        </>
      )}
      <p style={{ color: "var(--ms-muted)", fontSize: 13 }}>{copy.audit}</p>
      <ModalFooter>
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          onClick={() => {
            clearContent();
            onClose();
          }}
        >
          {copy.close}
          <span className="ms-keycap">Esc</span>
        </button>
      </ModalFooter>
    </Modal>
  );
}
