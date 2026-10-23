"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";

/** Only a receipt returns from this flow; the free text stays in the private review record. */
export function SignupReviewRequest({
  beforeSubmitAction,
}: {
  /** Prepare the safety hold only on submit; false means that no request is needed now. */
  beforeSubmitAction?: () => Promise<boolean>;
} = {}) {
  const t = useTranslations("console.banner.reviewRequest");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<"wait" | "failed" | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery(trpc.team.signupReview.queryOptions());
  const mutation = useMutation(trpc.team.requestSignupReview.mutationOptions());
  // A preparation success is not a request. Only the persisted read or the actual
  // request's server receipt can publish this state, including after reload.
  const pending = query.data?.pending === true;
  const busy = submitting || mutation.isPending;

  async function submit() {
    if (
      inFlight.current ||
      pending ||
      query.isPending ||
      query.isError ||
      context.trim().length < 20
    )
      return;
    inFlight.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      if (beforeSubmitAction && !(await beforeSubmitAction())) return;
      if (!mounted.current) return;
      const receipt = await mutation.mutateAsync({ context });
      if (!mounted.current) return;
      queries.setQueryData(trpc.team.signupReview.queryKey(), receipt);
      setContext("");
      setOpen(false);
      void query.refetch().catch(() => {});
    } catch (error) {
      // The request may have committed before its response was lost. Reconcile
      // the persisted receipt before showing a retry; the server deduplicates it.
      if (!mounted.current) return;
      const current = await query.refetch().catch(() => null);
      if (!mounted.current) return;
      if (current && !current.isError && current.data?.pending) {
        setContext("");
        setOpen(false);
      } else {
        const code = (error as { data?: { code?: string } } | null)?.data?.code;
        setSubmissionError(code === "TOO_MANY_REQUESTS" ? "wait" : "failed");
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }
  return (
    <div className="ms-card" style={{ padding: 16, marginBlock: 12 }}>
      {pending ? (
        <p role="status" style={{ margin: 0 }}>
          {t("received")}
        </p>
      ) : (
        <>
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
            disabled={busy || query.isPending || query.isError}
          >
            {t("button")}
          </button>
          {open ? (
            <form
              id={id}
              style={{ marginTop: 12 }}
              onSubmit={(event) => {
                event.preventDefault();
                return submit();
              }}
              aria-busy={busy}
            >
              <label htmlFor={`${id}-context`}>{t("label")}</label>
              <p id={`${id}-hint`} style={{ color: "var(--ms-muted)", fontSize: 13 }}>
                {t("hint")}
              </p>
              <input
                id={`${id}-context`}
                className="ms-input"
                type="text"
                minLength={20}
                maxLength={500}
                required
                disabled={busy}
                value={context}
                aria-describedby={`${id}-hint`}
                onChange={(event) => setContext(event.target.value)}
                style={{ width: "100%" }}
              />
              {submissionError ? <p role="alert">{t(submissionError)}</p> : null}
              <button
                className="ms-btn ms-btn-primary"
                type="submit"
                disabled={busy || context.trim().length < 20}
                style={{ marginTop: 12 }}
              >
                {t(busy ? "saving" : "submit")}
              </button>
            </form>
          ) : null}
        </>
      )}
      {query.isError ? (
        <p role="alert">
          {t(pending ? "refreshFailed" : "failed")}{" "}
          <button
            className="ms-btn ms-btn-secondary"
            type="button"
            onClick={() => void query.refetch()}
          >
            {t("retry")}
          </button>
        </p>
      ) : null}
    </div>
  );
}
