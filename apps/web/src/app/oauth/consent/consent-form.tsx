"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import styles from "@/components/auth/auth.module.css";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc";

/** Sentinel option value for an all-teams grant (core's ALL_TEAMS_GRANT). */
const ALL_TEAMS = "*";
/**
 * Drives refresh-token issuance rather than a permission; declining it means
 * the app must re-authorize once the hour-long access token expires.
 */
const OFFLINE_ACCESS = "offline_access";
/**
 * Scopes the dashboard reserves for owners/admins (adminProcedure); a member
 * is never offered them, mirroring the API's role check on the tools behind
 * them.
 */
const ADMIN_ONLY_SCOPES = ["domains:write", "webhooks:write", "api-keys:write"];
/**
 * Mail content scopes act only in the mailboxes ticked below (a credential bound to
 * this app is minted on Allow). Sending without asking is never pre-ticked.
 */
const MAIL_SCOPES = ["mail:read", "mail:draft", "mail:send"];
const MAIL_SEND = "mail:send";

export function ConsentForm({
  app,
  userEmail,
  scopes,
  teams,
  defaultTeamId,
  mailboxes = {},
}: {
  app: {
    clientId: string;
    name: string | null;
    uri: string | null;
    redirectOrigins: string[];
    unverified: boolean;
    registeredAt: string | null;
  } | null;
  userEmail: string;
  scopes: string[];
  teams: { teamId: string; teamName: string; role: "owner" | "admin" | "member" }[];
  defaultTeamId: string | null;
  /** The person's own active Correio mailboxes, per team. */
  mailboxes?: Record<string, { id: string; address: string; label: string }[]>;
}) {
  const t = useTranslations("auth.consent");
  const locale = useLocale();
  const trpc = useTRPC();
  const grantTeam = useMutation(trpc.team.grantTeam.mutationOptions());
  const grantMail = useMutation(trpc.mailboxes.grantOAuthClient.mutationOptions());
  const [teamId, setTeamId] = useState(defaultTeamId ?? teams[0]?.teamId ?? "");
  const [granted, setGranted] = useState(
    () => new Set(scopes.filter((scope) => scope !== MAIL_SEND)),
  );
  const [boxes, setBoxes] = useState<Set<string>>(
    () => new Set((mailboxes[defaultTeamId ?? teams[0]?.teamId ?? ""] ?? []).map((box) => box.id)),
  );
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);
  const appName = app?.name || t("unknownApp");
  // An all-teams grant counts as a member grant only when the user is a
  // member everywhere; the API re-checks the role per team on each call.
  const memberOnly =
    teamId === ALL_TEAMS
      ? teams.every((team) => team.role === "member")
      : (teams.find((team) => team.teamId === teamId)?.role ?? "member") === "member";
  const teamBoxes = teamId === ALL_TEAMS ? [] : (mailboxes[teamId] ?? []);
  // Mail needs one team and a mailbox of the person's own in it; otherwise it is not offered.
  const visible = (
    memberOnly ? scopes.filter((scope) => !ADMIN_ONLY_SCOPES.includes(scope)) : scopes
  ).filter((scope) => !MAIL_SCOPES.includes(scope) || teamBoxes.length > 0);
  const mailWanted = visible.some((scope) => MAIL_SCOPES.includes(scope) && granted.has(scope));
  const nothingGranted = visible.every((scope) => scope === OFFLINE_ACCESS || !granted.has(scope));

  function toggle(scope: string) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setFailed(false);
    try {
      // The grant binds to session.activeTeamId, so the selection must be
      // persisted (and membership-checked) before consent is recorded.
      if (accept) await grantTeam.mutateAsync({ teamId });
      const chosen = teamBoxes.filter((box) => boxes.has(box.id)).map((box) => box.id);
      const mailGranted = accept && mailWanted && chosen.length > 0;
      // The mail credential is minted before the consent, in the team just selected.
      if (mailGranted)
        await grantMail.mutateAsync({
          teamId,
          clientId: app?.clientId ?? "",
          mailboxIds: chosen,
          send: granted.has(MAIL_SEND),
        });
      const kept = visible.filter(
        (scope) => granted.has(scope) && (mailGranted || !MAIL_SCOPES.includes(scope)),
      );
      const { data, error } = await authClient.oauth2.consent({
        accept,
        // Omitted = everything requested; sent only when the user unticked
        // something, so the provider records exactly the approved subset.
        ...(accept && kept.length < scopes.length ? { scope: kept.join(" ") } : {}),
      });
      if (error) throw error;
      // The auth client's redirect plugin already navigates on `redirect: true`;
      // this covers a response without that flag.
      if (data?.url) window.location.assign(data.url);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <AuthScreen title={t("title", { app: appName })}>
      <p className={styles.subline}>
        {app?.uri ? (
          <a href={app.uri} target="_blank" rel="noopener noreferrer">
            {appName}
          </a>
        ) : (
          appName
        )}{" "}
        {t("subline", { email: userEmail })}
      </p>
      {app ? (
        <div
          style={{
            display: "grid",
            gap: 2,
            fontSize: "var(--ms-fs-micro)",
            color: "var(--ms-faint)",
            overflowWrap: "anywhere",
          }}
        >
          {app.unverified ? (
            <span>
              {t("unverified")}
              {app.registeredAt
                ? ` · ${t("registered", {
                    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                      new Date(app.registeredAt),
                    ),
                  })}`
                : null}
            </span>
          ) : null}
          {app.redirectOrigins.length > 0 ? (
            <span>{t("redirectsTo", { origins: app.redirectOrigins.join(", ") })}</span>
          ) : null}
          <span>
            {t("clientId")} <span className="ms-mono">{app.clientId}</span>
          </span>
        </div>
      ) : null}
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          decide(true);
        }}
      >
        <div className={`ms-field ${styles.field}`}>
          <label htmlFor="consent-team">{t("team")}</label>
          {teams.length > 0 ? (
            <Select
              id="consent-team"
              value={teamId}
              onChange={(next) => {
                setTeamId(next);
                setBoxes(new Set((mailboxes[next] ?? []).map((box) => box.id)));
              }}
              options={[
                ...teams.map((team) => ({ value: team.teamId, label: team.teamName })),
                ...(teams.length > 1 ? [{ value: ALL_TEAMS, label: t("allTeams") }] : []),
              ]}
              ariaLabel={t("team")}
              width="100%"
              disabled={pending !== null}
            />
          ) : (
            <p className={styles.notice} style={{ textAlign: "left" }}>
              {t("noTeam")} <Link href="/onboarding">{t("createTeam")}</Link>
            </p>
          )}
          <span style={{ fontSize: "var(--ms-fs-micro)", color: "var(--ms-faint)" }}>
            {teamId === ALL_TEAMS ? t("allTeamsNote") : t("teamNote")}
          </span>
        </div>
        <div className={`ms-field ${styles.field}`}>
          <span className="ms-microlabel">{t("permissions")}</span>
          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
            {visible.map((scope) => (
              <label
                key={scope}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--ms-fs-label)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  className="ms-checkbox"
                  checked={granted.has(scope)}
                  onChange={() => toggle(scope)}
                  disabled={pending !== null}
                />
                {t(`scopes.${scope.replace(":", "_")}`)}
              </label>
            ))}
          </div>
        </div>
        {mailWanted ? (
          <fieldset
            className={`ms-field ${styles.field}`}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            <legend className="ms-microlabel">{t("mailboxes")}</legend>
            <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
              {teamBoxes.map((box) => (
                <label
                  key={box.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: "var(--ms-fs-label)",
                    cursor: "pointer",
                    overflowWrap: "anywhere",
                  }}
                >
                  <input
                    type="checkbox"
                    className="ms-checkbox"
                    checked={boxes.has(box.id)}
                    onChange={() =>
                      setBoxes((prev) => {
                        const next = new Set(prev);
                        if (next.has(box.id)) next.delete(box.id);
                        else next.add(box.id);
                        return next;
                      })
                    }
                    disabled={pending !== null}
                  />
                  <span>
                    {box.label} <span className="ms-mono">{box.address}</span>
                  </span>
                </label>
              ))}
            </div>
            <span style={{ fontSize: "var(--ms-fs-micro)", color: "var(--ms-faint)" }}>
              {t(granted.has(MAIL_SEND) ? "mailboxesSendNote" : "mailboxesNote")}
            </span>
          </fieldset>
        ) : null}
        {failed ? (
          <p className={styles.error} role="alert">
            {t("error")}
          </p>
        ) : null}
        <button
          type="submit"
          className={`ms-btn ms-btn-primary ${styles.button}`}
          disabled={
            pending !== null ||
            teams.length === 0 ||
            nothingGranted ||
            (mailWanted && !teamBoxes.some((box) => boxes.has(box.id)))
          }
        >
          <BtnSpinner on={pending === "allow"} />
          {t("allow")}
        </button>
        <button
          type="button"
          className={`ms-btn ms-btn-secondary ${styles.button}`}
          disabled={pending !== null}
          onClick={() => decide(false)}
        >
          <BtnSpinner on={pending === "deny"} />
          {t("deny")}
        </button>
      </form>
    </AuthScreen>
  );
}
