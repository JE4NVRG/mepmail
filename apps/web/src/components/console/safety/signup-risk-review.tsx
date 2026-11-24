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
      <h2
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 12px" }}
      >
        {t("title")}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
        <p style={{ margin: 0 }}>
          {t("storedLevel", { level: risk.level ? t(`levels.${risk.level}`) : t("legacy") })}
        </p>
        <p style={{ margin: 0 }}>
          {t("effective", {
            status: t(
              `effectiveLevels.${risk.suspendedAt ? "suspended" : risk.sendReviewAt ? "held" : (risk.restriction ?? (risk.clearedAt || risk.level === "good" ? "none" : risk.level === "hold" ? "review" : "sandbox"))}`,
            ),
          })}
        </p>
        {risk.policyVersion ? (
          <p style={{ margin: 0, color: "var(--ms-muted)" }}>
            {t("policy", { version: risk.policyVersion })}
          </p>
        ) : null}
        {risk.reasons?.length ? (
          <p style={{ margin: 0, overflowWrap: "anywhere" }}>
            {t("reasons", { reasons: risk.reasons.join(", ") })}
          </p>
        ) : null}
      </div>
      {risk.request ? (
        <div
          style={{
            marginBlock: 16,
            paddingTop: 14,
            borderTop: "1px solid var(--ms-line)",
            overflowWrap: "anywhere",
          }}
        >
          <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "var(--ms-bone)" }}>
            {t("requestTitle")}
          </h3>
          <p style={{ margin: "0 0 6px", fontSize: 13 }}>{risk.request.context}</p>
          <p style={{ margin: "0 0 10px", color: "var(--ms-muted)", fontSize: 13 }}>
            {t("privateContext")}
          </p>
          {risk.request.resolvedAt ? (
            <p style={{ margin: 0, fontSize: 13, color: "var(--ms-muted)" }}>{t("resolved")}</p>
          ) : (
            <>
              <p style={{ margin: "0 0 10px", fontSize: 13 }}>{t("resolveScope")}</p>
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: teamId, reviewed: true })}
              >
                {t(resolve.isPending ? "saving" : "resolve")}
              </button>
              {resolve.isError ? (
                <p
                  role="alert"
                  style={{ margin: "8px 0 0", color: "var(--ms-danger)", fontSize: 13 }}
                >
                  {t("failed")}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>{t("scope")}</p>
      {!risk.clearedAt && risk.level && risk.level !== "good" && (
        <form
          style={{ marginTop: 14 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (reviewed && reason.trim().length >= 15)
              mutation.mutate({ id: teamId, reason, reviewed: true });
          }}
        >
          <div className="ms-field" style={{ marginBottom: 8 }}>
            <label htmlFor={reasonId}>{t("reason")}</label>
            <textarea
              id={reasonId}
              className="ms-input"
              style={{ width: "100%", minHeight: 80, resize: "vertical" }}
              minLength={15}
              maxLength={500}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            {t("confirm")}
          </label>
          {mutation.error && (
            <p
              role="alert"
              style={{ margin: "4px 0 8px", color: "var(--ms-danger)", fontSize: 13 }}
            >
              {t("failed")}
            </p>
          )}
          <button
            className="ms-btn ms-btn-secondary"
            style={{ marginTop: 4 }}
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
