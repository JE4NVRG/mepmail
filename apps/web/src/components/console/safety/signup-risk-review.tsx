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
  const resolve = useMutation(
    trpc.console.teams.resolveSignupReview.mutationOptions({
      onSuccess: () => void query.refetch(),
    }),
  );
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
      <p>{t("storedLevel", { level: risk.level ? t(`levels.${risk.level}`) : t("legacy") })}</p>
      <p>
        {t("effective", {
          status: t(
            `effectiveLevels.${risk.suspendedAt ? "suspended" : risk.sendReviewAt ? "held" : (risk.restriction ?? (risk.clearedAt || risk.level === "good" ? "none" : risk.level === "hold" ? "review" : "sandbox"))}`,
          ),
        })}
      </p>
      {risk.policyVersion ? <p>{t("policy", { version: risk.policyVersion })}</p> : null}
      {risk.reasons?.length ? <p>{t("reasons", { reasons: risk.reasons.join(", ") })}</p> : null}
      {risk.request ? (
        <div style={{ marginBlock: 16, overflowWrap: "anywhere" }}>
          <h3>{t("requestTitle")}</h3>
          <p>{risk.request.context}</p>
          <p style={{ color: "var(--ms-muted)", fontSize: 13 }}>{t("privateContext")}</p>
          {risk.request.resolvedAt ? (
            <p>{t("resolved")}</p>
          ) : (
            <>
              <p>{t("resolveScope")}</p>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: teamId, reviewed: true })}
              >
                {t(resolve.isPending ? "saving" : "resolve")}
              </button>
              {resolve.isError ? <p role="alert">{t("failed")}</p> : null}
            </>
          )}
        </div>
      ) : null}
      <p>{t("scope")}</p>
      {!risk.clearedAt && risk.level && risk.level !== "good" && (
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
