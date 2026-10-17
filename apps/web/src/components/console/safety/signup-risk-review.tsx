"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useTRPC } from "@/lib/trpc";

/** This decision clears only the signup sandbox. Existing held messages stay held. */
export function SignupRiskReview({ teamId }: { teamId: string }) {
  const t = useTranslations("console.signupRisk");
  const trpc = useTRPC();
  const reasonId = useId();
  const query = useQuery(trpc.console.teams.signupRisk.queryOptions({ id: teamId }));
  const mutation = useMutation(
    trpc.console.teams.clearSignupRisk.mutationOptions({
      onSuccess: () => {
        setReason("");
        setReviewed(false);
        void query.refetch();
      },
    }),
  );
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const risk = query.data;
  if (query.isError)
    return (
      <p role="alert">
        {t("failed")}{" "}
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          onClick={() => void query.refetch()}
        >
          {t("retry")}
        </button>
      </p>
    );
  if (!risk) return null;
  return (
    <section className="ms-card" style={{ padding: 20, marginBlock: 16 }}>
      <h2 style={{ marginTop: 0 }}>{t("title")}</h2>
      <p>{t("status", { status: t(`levels.${risk.clearedAt ? "good" : risk.level}`) })}</p>
      <p>{t("scope")}</p>
      {!risk.clearedAt && risk.level !== "good" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (reviewed && reason.trim().length >= 15)
              mutation.mutate({ id: teamId, reason, reviewed: true });
          }}
        >
          <label htmlFor={reasonId}>{t("reason")}</label>
          <textarea
            id={reasonId}
            className="ms-input"
            minLength={15}
            maxLength={500}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            {t("confirm")}
          </label>
          {mutation.error && <p role="alert">{t("failed")}</p>}
          <button
            className="ms-btn ms-btn-secondary"
            type="submit"
            disabled={mutation.isPending || !reviewed || reason.trim().length < 15}
          >
            {mutation.isPending ? t("saving") : t("clear")}
          </button>
        </form>
      )}
    </section>
  );
}
