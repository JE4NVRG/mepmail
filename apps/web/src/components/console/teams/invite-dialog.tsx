"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useId, useState } from "react";
import { CopyChip } from "@/components/copy-chip";
import { Modal } from "@/components/modal";
import { ConfirmKeycap, ModalFooter } from "@/components/modal-footer";
import { RelativeTime } from "@/components/relative-time";
import { Select } from "@/components/select";
import { BtnSpinner } from "@/components/spinner";
import { Table } from "@/components/table";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";

export type InviteRole = "member" | "admin";

/** A loose shape check for the button; the server's schema is the real gate. */
export const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** The server's refusal, in the dialog's words when it is one it knows. */
export function inviteErrorKey(error: { message: string; data?: { code?: string } | null } | null) {
  if (!error) return null;
  const code = error.data?.code;
  if (code === "CONFLICT") return "errors.conflict";
  if (code === "TOO_MANY_REQUESTS") return "errors.rate";
  return "errors.generic";
}

/** What the operator is about to send: shown in full before anything goes out. */
export function InviteReview({
  teamName,
  email,
  role,
}: {
  teamName: string;
  email: string;
  role: InviteRole;
}) {
  const t = useTranslations("console.teams.inviteDialog");
  return (
    <>
      <p style={{ margin: "6px 0 12px", color: "var(--ms-muted)", fontSize: 13.5 }}>
        {t("reviewLead")}
      </p>
      <dl className="ms-kv">
        <dt>{t("team")}</dt>
        <dd>{teamName}</dd>
        <dt>{t("email")}</dt>
        <dd className="ms-mono">{email}</dd>
        <dt>{t("role")}</dt>
        <dd>{t(`roles.${role}`)}</dd>
      </dl>
      <p style={{ margin: "12px 0 0", color: "var(--ms-muted)", fontSize: 12.5 }}>
        {t("reviewNote")}
      </p>
    </>
  );
}

/**
 * Console → team → Invite member: the operator invites someone into this
 * team without being in it (console.teams.invitations). Three steps: the
 * address and the role (Member by default; never Owner), a review naming
 * the team, the address and the role, then the result with the link. The
 * team's pending invitations sit under the form, with Resend and Revoke.
 */
export function InviteDialog({
  team,
  onClose,
}: {
  team: { id: string; name: string };
  onClose: () => void;
}) {
  const t = useTranslations("console.teams.inviteDialog");
  const common = useTranslations("console.common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const id = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [reviewing, setReviewing] = useState(false);
  const [armedRevoke, setArmedRevoke] = useState<string | null>(null);

  const pending = useQuery(trpc.console.teams.invitations.list.queryOptions({ teamId: team.id }));
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.console.teams.invitations.list.queryFilter({ teamId: team.id }),
    );
  const create = useMutation(
    trpc.console.teams.invitations.create.mutationOptions({ onSuccess: refresh }),
  );
  const failed = (error: { message: string }) =>
    toast(t("toast.failed", { message: error.message }), "danger");
  const resend = useMutation(
    trpc.console.teams.invitations.resend.mutationOptions({ onError: failed }),
  );
  const revoke = useMutation(
    trpc.console.teams.invitations.revoke.mutationOptions({ onError: failed }),
  );

  const normalized = email.trim().toLowerCase();
  const valid = looksLikeEmail(normalized);
  const close = useCallback(() => {
    create.reset();
    onClose();
  }, [create, onClose]);

  function confirm() {
    if (create.data) return close();
    if (!valid || create.isPending) return;
    if (!reviewing) return setReviewing(true);
    create.mutate({ teamId: team.id, email: normalized, role });
  }

  const errorKey = inviteErrorKey(create.error as Parameters<typeof inviteErrorKey>[0]);
  const title = create.data
    ? t(create.data.emailed ? "sentTitle" : "createdTitle")
    : reviewing
      ? t("reviewTitle")
      : t("title", { team: team.name });

  return (
    <Modal open onClose={close} onConfirm={confirm} title={title} size="wide">
      {create.data ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <p style={{ margin: "6px 0 0", color: "var(--ms-muted)", fontSize: 13.5 }}>
            {t(create.data.emailed ? "emailedBody" : "bodyTtl", {
              email: create.data.email,
              team: create.data.teamName,
              role: t(`roles.${create.data.role}`),
            })}
          </p>
          <CopyChip value={create.data.acceptUrl} />
          {create.data.emailed ? null : (
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t(create.data.noSender ? "noSender" : "sendFailed")}
            </p>
          )}
          <ModalFooter>
            <button type="button" className="ms-btn ms-btn-primary" onClick={close}>
              {t("done")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          {reviewing ? (
            <InviteReview teamName={team.name} email={normalized} role={role} />
          ) : (
            <>
              <p style={{ margin: "6px 0 16px", color: "var(--ms-muted)", fontSize: 13.5 }}>
                {t("lead")}
              </p>
              <div className="ms-field" style={{ marginBottom: 14 }}>
                <label htmlFor={`${id}-email`}>{t("email")}</label>
                <input
                  id={`${id}-email`}
                  type="email"
                  className="ms-input"
                  style={{ width: "100%" }}
                  required
                  autoComplete="off"
                  value={email}
                  placeholder={t("emailPlaceholder")}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="ms-field" style={{ marginBottom: 6 }}>
                <label htmlFor={`${id}-role`}>{t("role")}</label>
                <Select
                  id={`${id}-role`}
                  width="100%"
                  value={role}
                  ariaLabel={t("role")}
                  onChange={(value) => setRole(value === "admin" ? "admin" : "member")}
                  options={[
                    { value: "member", label: t("roles.member") },
                    { value: "admin", label: t("roles.admin") },
                  ]}
                />
              </div>
              <p style={{ margin: "0 0 4px", color: "var(--ms-muted)", fontSize: 12.5 }}>
                {t("roleHint")}
              </p>
            </>
          )}
          {reviewing && errorKey ? (
            <p
              role="alert"
              style={{
                margin: "12px 0 0",
                color: "var(--ms-danger)",
                fontSize: "var(--ms-fs-label)",
              }}
            >
              {t(errorKey, { email: normalized, message: create.error?.message ?? "" })}
            </p>
          ) : null}
          <ModalFooter>
            {reviewing ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={create.isPending}
                onClick={() => {
                  create.reset();
                  setReviewing(false);
                }}
              >
                {t("back")}
              </button>
            ) : (
              <button type="button" className="ms-btn ms-btn-secondary" onClick={close}>
                {common("cancel")} <span className="ms-keycap">Esc</span>
              </button>
            )}
            <button
              type="submit"
              className="ms-btn ms-btn-primary"
              disabled={!valid || create.isPending}
            >
              <BtnSpinner on={create.isPending} />
              {reviewing ? t("confirm") : t("next")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      )}
      {!create.data && !reviewing ? (
        <PendingList
          state={pendingListState(pending)}
          invitations={pending.data}
          retrying={pending.isFetching}
          onRetry={() => void pending.refetch()}
          busy={resend.isPending || revoke.isPending}
          armedRevoke={armedRevoke}
          onResend={(invite) =>
            resend.mutate(
              { teamId: team.id, id: invite.id },
              {
                onSuccess: () => {
                  toast(t("toast.resent", { email: invite.email }));
                  void refresh();
                },
              },
            )
          }
          onRevoke={(invite) => {
            if (armedRevoke !== invite.id) return setArmedRevoke(invite.id);
            setArmedRevoke(null);
            revoke.mutate(
              { teamId: team.id, id: invite.id },
              {
                onSuccess: () => {
                  toast(t("toast.revoked", { email: invite.email }));
                  void refresh();
                },
              },
            );
          }}
        />
      ) : null}
    </Modal>
  );
}

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  expiresAt: Date | string;
  sendCount: number;
}

export type PendingListState = "loading" | "error" | "empty" | "ready";

/**
 * What the pending list shows, from its query: a failure is its own state (with Try again),
 * never read as "still loading"; loading is only the first fetch.
 */
export function pendingListState(query: {
  data?: readonly unknown[] | undefined;
  isError: boolean;
  isPending: boolean;
}): PendingListState {
  if (query.isError) return "error";
  if (query.isPending || !query.data) return "loading";
  return query.data.length === 0 ? "empty" : "ready";
}

/** The list could not be read: says so, with Try again (the query's refetch). */
export function PendingListError({
  message,
  retryLabel,
  retrying,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ color: "var(--ms-danger)", fontSize: 13 }}>{message}</span>
      <button
        type="button"
        className="ms-btn ms-btn-secondary ms-btn-sm"
        disabled={retrying}
        onClick={onRetry}
      >
        <BtnSpinner on={retrying} />
        {retryLabel}
      </button>
    </div>
  );
}

/** The team's pending invitations: Resend, and Revoke after a second click on the same row. */
export function PendingList({
  state,
  invitations,
  retrying,
  onRetry,
  busy,
  armedRevoke,
  onResend,
  onRevoke,
}: {
  state: PendingListState;
  invitations: PendingInvite[] | undefined;
  retrying: boolean;
  onRetry: () => void;
  busy: boolean;
  armedRevoke: string | null;
  onResend: (invite: PendingInvite) => void;
  onRevoke: (invite: PendingInvite) => void;
}) {
  const t = useTranslations("console.teams.inviteDialog.pending");
  const roles = useTranslations("console.teams.inviteDialog.roles");
  return (
    <div style={{ marginTop: 20 }}>
      <div className="ms-microlabel" style={{ marginBottom: 8 }}>
        {t("title")}
      </div>
      {state === "error" ? (
        <PendingListError
          message={t("loadError")}
          retryLabel={t("retry")}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : state !== "ready" || !invitations ? (
        <p style={{ margin: 0, color: "var(--ms-muted)", fontSize: 13 }}>
          {state === "empty" ? t("none") : t("loading")}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t("email")}</th>
              <th>{t("role")}</th>
              <th>{t("expires")}</th>
              <th className="right" aria-label={t("actions")} />
            </tr>
          </thead>
          <tbody>
            {invitations.map((invite) => (
              <tr key={invite.id}>
                <td className="ms-mono">{invite.email}</td>
                <td>{invite.role === "admin" ? roles("admin") : roles("member")}</td>
                <td>
                  {new Date(invite.expiresAt).getTime() <= Date.now() ? (
                    <span className="ms-badge ms-badge-warn">{t("expired")}</span>
                  ) : (
                    <RelativeTime date={invite.expiresAt} />
                  )}
                </td>
                <td className="right" style={{ whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="ms-btn ms-btn-secondary ms-btn-sm"
                    disabled={busy}
                    style={{ marginRight: 8 }}
                    onClick={() => onResend(invite)}
                  >
                    {t("resend")}
                  </button>
                  <button
                    type="button"
                    className={`ms-btn ms-btn-sm ${armedRevoke === invite.id ? "ms-btn-destructive" : "ms-btn-secondary"}`}
                    disabled={busy}
                    onClick={() => onRevoke(invite)}
                  >
                    {armedRevoke === invite.id ? t("revokeConfirm") : t("revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
