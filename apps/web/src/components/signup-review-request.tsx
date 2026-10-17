"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useTRPC } from "@/lib/trpc";

/** Only a receipt returns from this flow; the free text stays in the private review record. */
export function SignupReviewRequest() {
  const t = useTranslations("console.banner.reviewRequest");
  const trpc = useTRPC();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState("");
  const query = useQuery(trpc.team.signupReview.queryOptions());
  const mutation = useMutation(
    trpc.team.requestSignupReview.mutationOptions({
      onSuccess: () => {
        setContext("");
        setOpen(false);
        void query.refetch();
      },
    }),
  );
  const pending = query.data?.pending || mutation.isSuccess;
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
            disabled={query.isPending || query.isError}
          >
            {t("button")}
          </button>
          {open ? (
            <form
              id={id}
              style={{ marginTop: 12 }}
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate({ context });
              }}
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
                value={context}
                aria-describedby={`${id}-hint`}
                onChange={(event) => setContext(event.target.value)}
                style={{ width: "100%" }}
              />
              {mutation.isError ? (
                <p role="alert">
                  {t(mutation.error.data?.code === "TOO_MANY_REQUESTS" ? "wait" : "failed")}
                </p>
              ) : null}
              <button
                className="ms-btn ms-btn-primary"
                type="submit"
                disabled={mutation.isPending || context.trim().length < 20}
                style={{ marginTop: 12 }}
              >
                {t(mutation.isPending ? "saving" : "submit")}
              </button>
            </form>
          ) : null}
        </>
      )}
      {query.isError ? (
        <p role="alert">
          {t("failed")}{" "}
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
