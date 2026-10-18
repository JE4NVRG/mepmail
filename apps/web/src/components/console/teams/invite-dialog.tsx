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
export type InviteProfile = InviteRole | "operations";

export interface OperationsInviteOptions {
  domains: { id: string; name: string }[];
  mailboxes: { id: string; address: string; label: string; domainId: string | null }[];
}

/** Re-resolve selected ids against the current server options; stale ids never widen a grant. */
export function selectedOperationsScope(
  options: OperationsInviteOptions | undefined,
  domainIds: readonly string[],
  mailboxIds: readonly string[],
) {
  const domains = options?.domains.filter((domain) => domainIds.includes(domain.id)) ?? [];
  const mailboxes =
    options?.mailboxes.filter(
      (mailbox) =>
        mailboxIds.includes(mailbox.id) && domains.some((d) => d.id === mailbox.domainId),
    ) ?? [];
  return {
    domains,
    mailboxes,
    valid:
      domains.length > 0 &&
      mailboxes.length > 0 &&
      domains.length === new Set(domainIds).size &&
      mailboxes.length === new Set(mailboxIds).size,
  };
}

/** Explicit, unselected-by-default scope choices inside the existing invitation form. */
export function OperationsScopeSelector({
  options,
  domainIds,
  mailboxIds,
  loading,
  error,
  retrying,
  onRetry,
  onDomainChange,
  onMailboxChange,
}: {
  options: OperationsInviteOptions | undefined;
  domainIds: string[];
  mailboxIds: string[];
  loading: boolean;
  error: boolean;
  retrying: boolean;
  onRetry: () => void;
  onDomainChange: (id: string, checked: boolean) => void;
  onMailboxChange: (id: string, checked: boolean) => void;
}) {
  const t = useTranslations("console.teams.inviteDialog.operations");
  const mailboxes =
    options?.mailboxes.filter(
      (mailbox) => mailbox.domainId !== null && domainIds.includes(mailbox.domainId),
    ) ?? [];
  const fieldsetStyle = { border: 0, padding: 0, margin: "14px 0 0", minWidth: 0 } as const;
  const optionStyle = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    cursor: "pointer",
    overflowWrap: "anywhere",
  } as const;
  return (
    <div aria-busy={loading} style={{ marginTop: 14, fontSize: 13.5 }}>
      <p style={{ margin: 0, color: "var(--ms-muted)" }}>{t("hint")}</p>
      {error ? (
        <PendingListError
          message={t("loadError")}
          retryLabel={t("retry")}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : loading || !options ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          <fieldset style={fieldsetStyle}>
            <legend className="ms-microlabel">{t("domains")}</legend>
            <p style={{ margin: "4px 0", color: "var(--ms-muted)" }}>{t("domainsHint")}</p>
            {options.domains.length === 0 ? <p>{t("noDomains")}</p> : null}
            {options.domains.map((domain) => (
              <label key={domain.id} style={optionStyle}>
                <input
                  type="checkbox"
                  checked={domainIds.includes(domain.id)}
                  onChange={(event) => onDomainChange(domain.id, event.target.checked)}
                />
                <span className="ms-mono">{domain.name}</span>
              </label>
            ))}
          </fieldset>
          <fieldset style={fieldsetStyle}>
            <legend className="ms-microlabel">{t("mailboxes")}</legend>
            <p style={{ margin: "4px 0", color: "var(--ms-muted)" }}>{t("mailboxesHint")}</p>
            {mailboxes.length === 0 ? <p>{t("noMailboxes")}</p> : null}
            {mailboxes.map((mailbox) => (
              <label key={mailbox.id} style={optionStyle}>
                <input
                  type="checkbox"
                  checked={mailboxIds.includes(mailbox.id)}
                  onChange={(event) => onMailboxChange(mailbox.id, event.target.checked)}
                />
                <span style={{ minWidth: 0 }}>
                  <span className="ms-mono">{mailbox.address}</span>
                  {mailbox.label ? (
                    <span style={{ display: "block", color: "var(--ms-muted)", fontSize: 12.5 }}>
                      {mailbox.label}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          <p style={{ color: "var(--ms-muted)" }}>{t("selectionRequired")}</p>
        </>
      )}
      <p style={{ marginBottom: 0, color: "var(--ms-muted)" }}>{t("exclusions")}</p>
    </div>
  );
}

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
  operations,
}: {
  teamName: string;
  email: string;
  role: InviteProfile;
  operations?: OperationsInviteOptions;
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
        {role === "operations" ? (
          <>
            <dt>{t("operations.userDirectory")}</dt>
            <dd>{t("operations.readOnly")}</dd>
            <dt>{t("operations.domains")}</dt>
            <dd style={{ overflowWrap: "anywhere" }}>
              {operations?.domains.map((domain) => (
                <div key={domain.id}>{domain.name}</div>
              ))}
            </dd>
            <dt>{t("operations.mailboxes")}</dt>
            <dd style={{ overflowWrap: "anywhere" }}>
              <p style={{ margin: "0 0 6px", color: "var(--ms-muted)", fontSize: 12.5 }}>
                {t("operations.mailboxAccess")}
              </p>
              {operations?.mailboxes.map((mailbox) => (
                <div key={mailbox.id} className="ms-mono">
                  {mailbox.address}
                </div>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      {role === "operations" ? (
        <>
          <p style={{ margin: "12px 0 0", color: "var(--ms-muted)", fontSize: 12.5 }}>
            {t("operations.exclusions")}
          </p>
          <p style={{ margin: "8px 0 0", color: "var(--ms-muted)", fontSize: 12.5 }}>
            {t("operations.reviewPending")}
          </p>
        </>
      ) : null}
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
  const [role, setRole] = useState<InviteProfile>("member");
  const [domainIds, setDomainIds] = useState<string[]>([]);
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [armedRevoke, setArmedRevoke] = useState<string | null>(null);

  const pending = useQuery(trpc.console.teams.invitations.list.queryOptions({ teamId: team.id }));
  const operationsOptions = useQuery(
    trpc.console.teams.invitations.operationsOptions.queryOptions(
      { teamId: team.id },
      { enabled: role === "operations" },
    ),
  );
  const refresh = () =>
    queryClient.invalidateQueries(
      trpc.console.teams.invitations.list.queryFilter({ teamId: team.id }),
    );
  const create = useMutation(
    trpc.console.teams.invitations.create.mutationOptions({ onSuccess: refresh }),
  );
  const createOperations = useMutation(
    trpc.console.teams.invitations.createOperations.mutationOptions({ onSuccess: refresh }),
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
  const operations = selectedOperationsScope(
    role === "operations" ? operationsOptions.data : undefined,
    domainIds,
    mailboxIds,
  );
  const valid =
    looksLikeEmail(normalized) &&
    (role !== "operations" ||
      (!operationsOptions.isPending && !operationsOptions.isError && operations.valid));
  const busy = create.isPending || createOperations.isPending;
  const created = createOperations.data ?? create.data;
  const createError = role === "operations" ? createOperations.error : create.error;
  const close = useCallback(() => {
    create.reset();
    createOperations.reset();
    onClose();
  }, [create, createOperations, onClose]);

  function confirm() {
    if (created) return close();
    if (!valid || busy) return;
    if (!reviewing) return setReviewing(true);
    if (role === "operations") {
      createOperations.mutate({ teamId: team.id, email: normalized, domainIds, mailboxIds });
    } else {
      create.mutate({ teamId: team.id, email: normalized, role });
    }
  }

  const errorKey = inviteErrorKey(createError as Parameters<typeof inviteErrorKey>[0]);
  const title = created
    ? t(created.emailed ? "sentTitle" : "createdTitle")
    : reviewing
      ? t("reviewTitle")
      : t("title", { team: team.name });

  return (
    <Modal open onClose={close} onConfirm={confirm} title={title} size="wide">
      {created ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <p style={{ margin: "6px 0 0", color: "var(--ms-muted)", fontSize: 13.5 }}>
            {t(created.emailed ? "emailedBody" : "bodyTtl", {
              email: created.email,
              team: created.teamName,
              role: t(`roles.${createOperations.data ? "operations" : created.role}`),
            })}
          </p>
          <CopyChip value={created.acceptUrl} />
          {created.emailed ? null : (
            <p style={{ margin: 0, color: "var(--ms-warn)", fontSize: "var(--ms-fs-label)" }}>
              {t(created.noSender ? "noSender" : "sendFailed")}
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
            <InviteReview
              teamName={team.name}
              email={normalized}
              role={role}
              operations={operations}
            />
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
                  onChange={(value) => {
                    setRole(
                      value === "operations"
                        ? "operations"
                        : value === "admin"
                          ? "admin"
                          : "member",
                    );
                    setDomainIds([]);
                    setMailboxIds([]);
                  }}
                  options={[
                    { value: "member", label: t("roles.member") },
                    { value: "admin", label: t("roles.admin") },
                    { value: "operations", label: t("roles.operations") },
                  ]}
                />
              </div>
              <p style={{ margin: "0 0 4px", color: "var(--ms-muted)", fontSize: 12.5 }}>
                {t("roleHint")}
              </p>
              {role === "operations" ? (
                <OperationsScopeSelector
                  options={operationsOptions.data}
                  domainIds={domainIds}
                  mailboxIds={mailboxIds}
                  loading={operationsOptions.isPending}
                  error={operationsOptions.isError}
                  retrying={operationsOptions.isFetching}
                  onRetry={() => void operationsOptions.refetch()}
                  onDomainChange={(domainId, checked) => {
                    setDomainIds((ids) =>
                      checked
                        ? [...new Set([...ids, domainId])]
                        : ids.filter((id) => id !== domainId),
                    );
                    if (!checked) {
                      const removedMailboxIds = new Set(
                        operationsOptions.data?.mailboxes
                          .filter((mailbox) => mailbox.domainId === domainId)
                          .map((mailbox) => mailbox.id),
                      );
                      setMailboxIds((ids) => ids.filter((id) => !removedMailboxIds.has(id)));
                    }
                  }}
                  onMailboxChange={(mailboxId, checked) =>
                    setMailboxIds((ids) =>
                      checked
                        ? [...new Set([...ids, mailboxId])]
                        : ids.filter((id) => id !== mailboxId),
                    )
                  }
                />
              ) : null}
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
              {t(errorKey, { email: normalized, message: createError?.message ?? "" })}
            </p>
          ) : null}
          <ModalFooter>
            {reviewing ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={busy}
                onClick={() => {
                  create.reset();
                  createOperations.reset();
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
            <button type="submit" className="ms-btn ms-btn-primary" disabled={!valid || busy}>
              <BtnSpinner on={busy} />
              {reviewing ? t("confirm") : t("next")} <ConfirmKeycap />
            </button>
          </ModalFooter>
        </form>
      )}
      {!created && !reviewing ? (
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
