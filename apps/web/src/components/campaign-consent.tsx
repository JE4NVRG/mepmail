"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { useId, useState } from "react";
import { useTRPC } from "@/lib/trpc";

const copy = {
  en: {
    title: "Consent review",
    intro:
      "Campaigns and contact imports stay blocked until an independent operator approves your opt-in evidence, your sending domain passes SPF, DKIM and DMARC, and the account passes manual review. New senders keep a low daily limit for transactional messages. Paying or selecting ‘transactional’ does not approve a campaign.",
    privacy:
      "Keep the original evidence in your custody. Send only masked record references and a public form URL, never a contact list, complete IP address, credentials or secret link.",
    source: "Where did this list come from?",
    method: "How did people subscribe?",
    formUrl: "Public signup form URL (HTTPS, no query string)",
    permissionText: "Exact permission wording shown at signup",
    permissionScope: "What messages did people agree to receive?",
    listReference: "List reference (no addresses)",
    reference: "Masked sample reference",
    registeredAt: "Sample registration date and time",
    ipAvailable: "IP evidence exists in our records",
    ipReference: "Reference to retained IP evidence (not the IP itself)",
    submit: "Request independent review",
    pending: "Awaiting review",
    approved: "Evidence approved",
    rejected: "Evidence rejected",
    revoked: "Approval revoked",
    missing: "No evidence submitted",
    loading: "Loading consent review…",
    error: "Could not load consent review. Refresh to retry.",
    ready: "Campaign and import requirements met. Other safety and quota limits still apply.",
    blocked:
      "Campaigns and imports remain blocked. Check your domain and request account review through Support.",
    reason: "Review reason (at least 15 characters)",
    approve: "Approve evidence",
    reject: "Reject evidence",
    revoke: "Revoke approval",
    reviewNote:
      "This decision is audited. It does not release held mail, resume a suspended account or send a queue.",
    saved: "Saved. The latest status is shown below.",
    open: "Open consent review",
    reviewLink: "Review opt-in evidence",
    readOnly:
      "Only a team owner or administrator can submit evidence. Approval is reserved for an independent instance operator.",
  },
  "pt-BR": {
    title: "Revisão de consentimento",
    intro:
      "Campanhas e importações ficam bloqueadas até a aprovação independente das evidências de opt-in, a verificação de SPF, DKIM e DMARC do domínio e a revisão manual da conta. Novos remetentes mantêm limite diário baixo para mensagens transacionais. Pagar ou selecionar ‘transacional’ não aprova uma campanha.",
    privacy:
      "Mantenha a prova original sob sua custódia. Envie apenas referências camufladas e a URL pública do formulário, nunca uma lista de contatos, IP completo, credenciais ou link secreto.",
    source: "Qual é a origem desta lista?",
    method: "Como as pessoas se inscreveram?",
    formUrl: "URL pública do formulário (HTTPS, sem parâmetros)",
    permissionText: "Texto exato da permissão apresentada na inscrição",
    permissionScope: "Quais mensagens as pessoas autorizaram receber?",
    listReference: "Referência da lista (sem endereços)",
    reference: "Referência camuflada da amostra",
    registeredAt: "Data e hora da inscrição da amostra",
    ipAvailable: "Há evidência de IP nos nossos registros",
    ipReference: "Referência da evidência de IP retida (não o IP)",
    submit: "Solicitar revisão independente",
    pending: "Aguardando revisão",
    approved: "Evidência aprovada",
    rejected: "Evidência rejeitada",
    revoked: "Aprovação revogada",
    missing: "Nenhuma evidência enviada",
    loading: "Carregando revisão de consentimento…",
    error: "Não foi possível carregar a revisão. Atualize para tentar novamente.",
    ready:
      "Requisitos de campanha e importação atendidos. Outros controles de segurança e limites continuam válidos.",
    blocked:
      "Campanhas e importações continuam bloqueadas. Verifique o domínio e solicite a revisão da conta pelo Suporte.",
    reason: "Motivo da decisão (ao menos 15 caracteres)",
    approve: "Aprovar evidência",
    reject: "Rejeitar evidência",
    revoke: "Revogar aprovação",
    reviewNote:
      "Esta decisão é auditada. Não libera mensagens retidas, não reativa contas suspensas nem envia uma fila.",
    saved: "Salvo. O estado atualizado aparece abaixo.",
    open: "Abrir revisão de consentimento",
    reviewLink: "Revisar evidências de opt-in",
    readOnly:
      "Somente proprietários e administradores podem enviar evidências. A aprovação é exclusiva de um operador independente da instância.",
  },
};

type Evidence = {
  listReference: string;
  source: string;
  method: string;
  formUrl: string;
  permissionText: string;
  permissionScope: string;
  samples: {
    reference: string;
    registeredAt: string;
    ipAvailable: boolean;
    ipReference?: string;
  }[];
};
type Dossier = {
  id: string;
  evidence: Evidence;
  status: "pending" | "approved" | "rejected" | "revoked";
  submittedAt: Date;
  reviewedAt: Date | null;
  reason: string | null;
};
export function ConsentReviewPanel({
  locale,
  dossier,
  allowed,
  busy,
  error,
  onSubmit,
  onReview,
}: {
  locale: string;
  dossier: Dossier | null;
  allowed: boolean;
  busy: boolean;
  error?: string | undefined;
  onSubmit?: ((evidence: Evidence) => void) | undefined;
  onReview?: ((decision: "approved" | "rejected" | "revoked", reason: string) => void) | undefined;
}) {
  const t = copy[locale === "pt-BR" ? "pt-BR" : "en"];
  const id = useId();
  const [ipAvailable, setIpAvailable] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <section
      aria-labelledby={`${id}-heading`}
      aria-busy={busy}
      className="ms-card"
      style={{
        padding: 24,
        marginBottom: 24,
        minWidth: 0,
        overflowWrap: "anywhere",
        fontSize: "var(--ms-fs-body)",
        lineHeight: 1.6,
      }}
    >
      <h2 id={`${id}-heading`} style={{ fontSize: 18, marginBottom: 12 }}>
        {t.title}
      </h2>
      <p>{t.intro}</p>
      <p>{t.privacy}</p>
      <p role="status">
        <strong>{dossier ? t[dossier.status] : t.missing}</strong> · {allowed ? t.ready : t.blocked}
      </p>
      {error && <p role="alert">{error}</p>}
      {dossier && (
        <>
          <p>
            {new Date(dossier.submittedAt).toLocaleString(locale)}
            {dossier.reviewedAt ? ` · ${new Date(dossier.reviewedAt).toLocaleString(locale)}` : ""}
          </p>
          {dossier.reason && <p>{dossier.reason}</p>}
        </>
      )}
      {!onSubmit && !onReview && <p>{t.readOnly}</p>}
      {onSubmit && (
        <details>
          <summary style={{ cursor: "pointer", padding: "12px 0" }}>{t.open}</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !event.currentTarget.reportValidity()) return;
              const form = new FormData(event.currentTarget);
              const get = (key: string) => String(form.get(key) ?? "").trim();
              onSubmit({
                listReference: get("listReference"),
                source: get("source"),
                method: get("method"),
                formUrl: get("formUrl"),
                permissionText: get("permissionText"),
                permissionScope: get("permissionScope"),
                samples: [
                  {
                    reference: get("reference"),
                    registeredAt: new Date(get("registeredAt")).toISOString(),
                    ipAvailable,
                    ...(ipAvailable ? { ipReference: get("ipReference") } : {}),
                  },
                ],
              });
            }}
            style={{ display: "grid", gap: 16, maxWidth: 720 }}
          >
            <fieldset
              disabled={busy}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 16 }}
            >
              {(
                [
                  "listReference",
                  "source",
                  "method",
                  "formUrl",
                  "permissionText",
                  "permissionScope",
                  "reference",
                  "registeredAt",
                ] as const
              ).map((key) => (
                <label key={key} htmlFor={`${id}-${key}`} style={{ display: "grid", gap: 6 }}>
                  {t[key]}
                  {["source", "permissionText", "permissionScope"].includes(key) ? (
                    <textarea
                      id={`${id}-${key}`}
                      name={key}
                      className="ms-input"
                      style={{
                        width: "100%",
                        minWidth: 0,
                        fontSize: 13,
                        height: "auto",
                        minHeight: 80,
                      }}
                      required
                      minLength={key === "permissionText" ? 20 : 15}
                      maxLength={key === "permissionText" ? 1000 : 500}
                      rows={3}
                    />
                  ) : (
                    <input
                      id={`${id}-${key}`}
                      name={key}
                      className="ms-input"
                      style={{ width: "100%", minWidth: 0, fontSize: 13 }}
                      required
                      type={
                        key === "formUrl"
                          ? "url"
                          : key === "registeredAt"
                            ? "datetime-local"
                            : "text"
                      }
                      pattern={key === "formUrl" ? "https://[^?#]+" : undefined}
                      minLength={key === "method" ? 10 : key === "registeredAt" ? undefined : 3}
                      maxLength={key === "formUrl" ? 500 : key === "method" ? 300 : 160}
                    />
                  )}
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={ipAvailable}
                  onChange={(e) => setIpAvailable(e.target.checked)}
                />{" "}
                {t.ipAvailable}
              </label>
              {ipAvailable && (
                <label>
                  {t.ipReference}
                  <input
                    className="ms-input"
                    style={{ width: "100%", minWidth: 0, fontSize: 13 }}
                    name="ipReference"
                    required
                    minLength={3}
                    maxLength={160}
                  />
                </label>
              )}
              <p>{t.readOnly}</p>
              <button className="ms-btn ms-btn-primary" type="submit" disabled={busy}>
                {t.submit}
              </button>
            </fieldset>
          </form>
        </details>
      )}
      {onReview && dossier && (
        <>
          <dl>
            {Object.entries(dossier.evidence).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {key in t ? t[key as keyof typeof t] : key === "samples" ? t.reference : key}
                </dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>
                  {typeof value === "string"
                    ? value
                    : value.map((sample: Evidence["samples"][number]) => (
                        <p key={sample.reference}>
                          {sample.reference} ·{" "}
                          {new Date(sample.registeredAt).toLocaleString(locale)}
                          {sample.ipAvailable && sample.ipReference
                            ? ` · ${t.ipReference}: ${sample.ipReference}`
                            : ""}
                        </p>
                      ))}
                </dd>
              </div>
            ))}
          </dl>
          <p>{t.reviewNote}</p>
          <label style={{ display: "grid", gap: 8 }}>
            {t.reason}
            <textarea
              className="ms-input"
              style={{ width: "100%", minWidth: 0, fontSize: 13, height: "auto", minHeight: 80 }}
              disabled={busy}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={15}
              maxLength={500}
              rows={3}
            />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
            {(dossier.status === "pending"
              ? (["approved", "rejected"] as const)
              : dossier.status === "approved"
                ? (["revoked"] as const)
                : []
            ).map((decision) => (
              <button
                key={decision}
                className="ms-btn"
                type="button"
                disabled={busy || reason.trim().length < 15}
                onClick={() => {
                  if (!busy && reason.trim().length >= 15) onReview(decision, reason.trim());
                }}
              >
                {decision === "approved"
                  ? t.approve
                  : decision === "rejected"
                    ? t.reject
                    : t.revoke}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function CampaignConsentClient({ canSubmit = false }: { canSubmit?: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const locale = useLocale();
  const t = copy[locale === "pt-BR" ? "pt-BR" : "en"];
  const status = useQuery(trpc.audience.consent.status.queryOptions());
  const submit = useMutation(
    trpc.audience.consent.submit.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.audience.consent.status.queryKey() }),
    }),
  );
  if (status.isPending) return <p role="status">{t.loading}</p>;
  if (status.isError) return <p role="alert">{t.error}</p>;
  return (
    <ConsentReviewPanel
      locale={locale}
      dossier={status.data.dossier}
      allowed={status.data.eligibility.allowed}
      busy={submit.isPending}
      error={submit.error?.message}
      onSubmit={canSubmit ? (evidence) => submit.mutate(evidence) : undefined}
    />
  );
}

export function CampaignConsentOperator({ teamId }: { teamId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const locale = useLocale();
  const t = copy[locale === "pt-BR" ? "pt-BR" : "en"];
  const status = useQuery(trpc.audience.consent.operatorStatus.queryOptions({ teamId }));
  const review = useMutation(
    trpc.audience.consent.review.mutationOptions({
      onSuccess: () =>
        qc.invalidateQueries({
          queryKey: trpc.audience.consent.operatorStatus.queryKey({ teamId }),
        }),
    }),
  );
  if (status.isPending) return <p role="status">{t.loading}</p>;
  if (status.isError) return <p role="alert">{t.error}</p>;
  return (
    <ConsentReviewPanel
      locale={locale}
      dossier={status.data.dossier}
      allowed={status.data.eligibility.allowed}
      busy={review.isPending}
      error={review.error?.message}
      onReview={(decision, reason) => {
        if (status.data.dossier)
          review.mutate({ teamId, dossierId: status.data.dossier.id, decision, reason });
      }}
    />
  );
}
