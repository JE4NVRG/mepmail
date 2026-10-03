"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { NavGlyph } from "@/components/icons/nav-icons";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { MailboxAgentKeysDialog } from "./mailbox-agent-keys";
import { MailboxContentView } from "./mailbox-content-view";
import { MailboxServicePanel } from "./mailbox-service-panel";
import styles from "./mailboxes.module.css";

type Outputs = inferRouterOutputs<AppRouter>["mailboxes"];
type Box = Outputs["list"]["mailboxes"][number];
type Options = Outputs["options"];

function RegistryDialog({
  mailbox,
  options,
  close,
  changed,
}: {
  mailbox: Box | null;
  options: Options;
  close: () => void;
  changed: (id: string) => Promise<void>;
}) {
  const t = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [domainId, setDomain] = useState(options.domains[0]?.id ?? "");
  const [owner, setOwner] = useState(mailbox?.ownerUserId ?? options.currentUserId);
  const [label, setLabel] = useState(mailbox?.label ?? "");
  const [local, setLocal] = useState("");
  const [kind, setKind] = useState<"person" | "agent">(mailbox?.kind ?? "person");
  const [status, setStatus] = useState<"planned" | "suspended">(mailbox?.status ?? "planned");
  const [person, setPerson] = useState("");
  const [permission, setPermission] = useState<"read" | "draft">("read");
  const [error, setError] = useState("");
  const grants = useQuery(
    trpc.mailboxes.grants.queryOptions(
      { mailboxId: mailbox?.id ?? "00000000-0000-0000-0000-000000000000" },
      { enabled: !!mailbox },
    ),
  );
  const create = useMutation(trpc.mailboxes.create.mutationOptions());
  const update = useMutation(trpc.mailboxes.update.mutationOptions());
  const grant = useMutation(trpc.mailboxes.grant.mutationOptions());
  const revoke = useMutation(trpc.mailboxes.revoke.mutationOptions());
  const busy = create.isPending || update.isPending || grant.isPending || revoke.isPending;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  function failed(cause: unknown) {
    const code = (cause as { data?: { code?: string } })?.data?.code;
    setError(t(code === "CONFLICT" ? "conflict" : "error"));
  }
  async function refreshGrants() {
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.grants.queryKey() });
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
  }
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="mailbox-dialog-title"
      onClose={close}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <header className={styles.dialogHeader}>
        <h2 id="mailbox-dialog-title">{t(mailbox ? "manage" : "new")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={t("close")}
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            const result = mailbox
              ? await update.mutateAsync({ id: mailbox.id, label, ownerUserId: owner, status })
              : await create.mutateAsync({
                  domainId,
                  localPart: local,
                  label,
                  kind,
                  ownerUserId: owner,
                });
            await changed(result.id);
            close();
          } catch (cause) {
            failed(cause);
          }
        }}
      >
        <fieldset disabled={busy} className={styles.fields}>
          <label>
            {t("name")}
            <input
              className="ms-input"
              required
              maxLength={80}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </label>
          {mailbox ? (
            <p className={styles.address}>{mailbox.address}</p>
          ) : (
            <>
              <div className={styles.addressFields}>
                <label>
                  {t("localPart")}
                  <input
                    className="ms-input"
                    required
                    maxLength={64}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                    placeholder="jean"
                    value={local}
                    onChange={(e) => setLocal(e.target.value)}
                    autoCapitalize="none"
                    autoComplete="off"
                  />
                </label>
                <span>@</span>
                <label>
                  {t("domain")}
                  <select
                    className="ms-input"
                    required
                    value={domainId}
                    onChange={(e) => setDomain(e.target.value)}
                  >
                    {options.domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.kind}>
                <button
                  type="button"
                  aria-pressed={kind === "person"}
                  onClick={() => setKind("person")}
                >
                  {t("person")}
                </button>
                <button
                  type="button"
                  aria-pressed={kind === "agent"}
                  onClick={() => setKind("agent")}
                >
                  {t("agent")}
                </button>
              </div>
            </>
          )}
          <label>
            {t("owner")}
            <select
              className="ms-input"
              required
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">{t("ownerMissing")}</option>
              {options.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.email}
                </option>
              ))}
            </select>
          </label>
          {mailbox ? (
            <label>
              {t("status")}
              <select
                className="ms-input"
                value={status}
                onChange={(e) => setStatus(e.target.value as "planned" | "suspended")}
              >
                <option value="planned">{t("planned")}</option>
                <option value="suspended">{t("suspended")}</option>
              </select>
            </label>
          ) : (
            <p className={styles.hint}>{t("createHint")}</p>
          )}
        </fieldset>
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        <footer className={styles.dialogFooter}>
          <button type="button" className="ms-btn" disabled={busy} onClick={close}>
            {t("cancel")}
          </button>
          <button
            type="submit"
            className="ms-btn ms-btn-primary"
            disabled={busy || (!mailbox && !options.domains.length)}
          >
            {t(busy ? "saving" : mailbox ? "save" : "create")}
          </button>
        </footer>
      </form>
      {mailbox ? (
        <section className={styles.access}>
          <h3>{t("access")}</h3>
          <p className={styles.hint}>{t("accessHint")}</p>
          {grants.isError ? (
            <div role="alert">
              <p>{t("loadError")}</p>
              <button type="button" className="ms-btn" onClick={() => void grants.refetch()}>
                {t("retry")}
              </button>
            </div>
          ) : grants.isPending ? (
            <p>{t("loading")}</p>
          ) : grants.data?.length ? (
            <ul>
              {grants.data.map((g) => (
                <li key={g.id}>
                  <span>
                    {g.name}
                    <small>
                      {g.email} · {t(g.permission)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="ms-btn ms-btn-ghost"
                    disabled={busy}
                    onClick={async () => {
                      setError("");
                      try {
                        await revoke.mutateAsync({ id: g.id });
                        await refreshGrants();
                      } catch (cause) {
                        failed(cause);
                      }
                    }}
                  >
                    {t("revoke")}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>{t("noGrants")}</p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await grant.mutateAsync({ mailboxId: mailbox.id, userId: person, permission });
                setPerson("");
                await refreshGrants();
              } catch (cause) {
                failed(cause);
              }
            }}
          >
            <fieldset disabled={busy || !grants.isSuccess} className={styles.fields}>
              <label>
                {t("recipient")}
                <select
                  className="ms-input"
                  required
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                >
                  <option value="">{t("noSelection")}</option>
                  {options.members
                    .filter((m) => m.id !== mailbox.ownerUserId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.email}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                {t("permission")}
                <select
                  className="ms-input"
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as "read" | "draft")}
                >
                  <option value="read">{t("read")}</option>
                  <option value="draft">{t("draft")}</option>
                </select>
              </label>
              <button type="submit" className="ms-btn" disabled={busy || !person}>
                {t("grant")}
              </button>
            </fieldset>
          </form>
        </section>
      ) : null}
    </dialog>
  );
}

export function MailboxesView() {
  const t = useTranslations("mailboxes");
  const agentT = useTranslations("mailboxes-agent");
  const { data: session } = authClient.useSession();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const capability = useQuery(trpc.mailboxes.capabilities.queryOptions());
  const registry = useQuery(
    trpc.mailboxes.list.queryOptions(undefined, {
      enabled: capability.data?.enabled === true,
      refetchInterval: 15000,
    }),
  );
  const options = useQuery(
    trpc.mailboxes.options.queryOptions(undefined, { enabled: registry.data?.canManage === true }),
  );
  const [selectedId, select] = useState<string | null>(null);
  const [itemSelection, selectItem] = useState<{ mailboxId: string; id: string } | null>(null);
  const [folder, setFolder] = useState<"inbox" | "drafts" | "sent">("inbox");
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [agentDialogId, setAgentDialogId] = useState<string | null>(null);
  // Team switches cause a full navigation. Every id is also resolved against this request's scoped DTO.
  const boxes = registry.data?.mailboxes ?? [];
  const selected = boxes.find((b) => b.id === selectedId) ?? null;
  const agentBox = boxes.find(
    (box) => box.id === agentDialogId && box.ownerActive && box.ownerUserId === session?.user.id,
  );
  function selectMailbox(id: string | null) {
    selectItem(null);
    select(id);
  }
  async function changed(id: string) {
    await queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() });
    selectMailbox(id);
  }
  if (capability.isPending || (capability.data?.enabled && registry.isPending))
    return <p aria-live="polite">{t("loading")}</p>;
  if (capability.isError || registry.isError)
    return (
      <div role="alert">
        <p>{t("loadError")}</p>
        <button
          type="button"
          className="ms-btn"
          onClick={() => {
            void capability.refetch();
            void registry.refetch();
          }}
        >
          {t("retry")}
        </button>
      </div>
    );
  if (!capability.data?.enabled)
    return (
      <section>
        <h1>{t("title")}</h1>
        <p>{t("disabled")}</p>
      </section>
    );
  const navigation = (
    <div className={styles.workspaceNavigation}>
      <label>
        <span className={styles.visuallyHidden}>{t("chooseBox")}</span>
        <select
          className="ms-input"
          aria-label={t("chooseBox")}
          value={selected?.id ?? ""}
          onChange={(e) => selectMailbox(e.target.value || null)}
        >
          <option value="">{t("all")}</option>
          {boxes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label} · {b.address}
            </option>
          ))}
        </select>
      </label>
      <nav className={styles.compactFolders} aria-label={t("folders")}>
        {(["inbox", "drafts", "sent"] as const).map((f) => (
          <button
            type="button"
            key={f}
            aria-current={f === folder ? "page" : undefined}
            onClick={() => setFolder(f)}
          >
            {t(f)}
          </button>
        ))}
      </nav>
    </div>
  );
  return (
    <section className={styles.view}>
      <header className={styles.header}>
        <div>
          <div className={styles.productMeta}>
            <h1>{t("title")}</h1>
            <span className={styles.serviceBadge}>{t("paidService")}</span>
          </div>
          <p>{t("subtitle")}</p>
        </div>
        <div className={styles.headerActions}>
          {selected?.ownerActive && selected.ownerUserId === session?.user.id ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => setAgentDialogId(selected.id)}
            >
              {agentT("title")}
            </button>
          ) : null}
          {registry.data?.canManage ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              disabled={!options.data?.domains.length}
              onClick={() => setDialog("new")}
            >
              + {t("new")}
            </button>
          ) : null}
        </div>
      </header>
      <p className={styles.previewNote}>
        <span>{t("preview")}</span> {t("previewBody")}
      </p>
      <MailboxServicePanel />
      {registry.data?.canManage && options.data && !options.data.domains.length ? (
        <p className={styles.notice}>
          {t("noDomains")} <Link href="/domains">{t("domainsLink")} ↗</Link>
        </p>
      ) : null}
      {options.isError && registry.data?.canManage ? (
        <div role="alert">
          <p>{t("loadError")}</p>
          <button type="button" className="ms-btn" onClick={() => void options.refetch()}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      <div className={styles.workspace}>
        {(!selected || (selected.canRead && selected.status === "planned")) &&
        boxes.some((b) => b.canRead && b.status === "planned") ? (
          <MailboxContentView
            key={selected?.id ?? "all"}
            navigation={navigation}
            boxes={boxes}
            selected={selected}
            folder={folder}
            changeFolder={setFolder}
            selection={itemSelection}
            select={selectItem}
            draftSaved={(saved) => {
              select(saved.mailboxId);
              setFolder("drafts");
              selectItem({ mailboxId: saved.mailboxId, id: saved.id });
            }}
            manage={
              selected && registry.data?.canManage && options.data
                ? () => setDialog("edit")
                : undefined
            }
          />
        ) : (
          <div className={styles.registryWorkspace}>
            <header className={styles.contentToolbar}>{navigation}</header>
            <div className={styles.registryState}>
              <div className={styles.hero}>
                <NavGlyph name="emails" hovered={false} />
                <h2>{selected?.label ?? t("emptyTitle")}</h2>
                {selected ? (
                  <>
                    <p className={styles.address}>{selected.address}</p>
                    <span className={styles.tag}>{t(selected.status)}</span>
                    <p>{t(selected.status === "suspended" ? "pausedBody" : "preparingBody")}</p>
                    {!selected.ownerActive ? (
                      <p className={styles.hint}>{t("ownerMissing")}</p>
                    ) : null}
                    {!selected.canRead ? (
                      <p className={styles.hint}>{t("managementOnly")}</p>
                    ) : null}
                    {registry.data?.canManage ? (
                      <button
                        type="button"
                        className="ms-btn"
                        disabled={!options.data}
                        onClick={() => setDialog("edit")}
                      >
                        {t("manage")}
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p>{t("emptyBody")}</p>
                    {registry.data?.canManage && options.data?.domains.length ? (
                      <button
                        type="button"
                        className="ms-btn ms-btn-primary"
                        onClick={() => setDialog("new")}
                      >
                        {t("createFirst")}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      {dialog && options.data && (dialog === "new" || selected) ? (
        <RegistryDialog
          key={dialog === "new" ? "new" : selected!.id}
          mailbox={dialog === "edit" ? selected : null}
          options={options.data}
          close={() => setDialog(null)}
          changed={changed}
        />
      ) : null}
      {agentBox ? (
        <MailboxAgentKeysDialog
          key={agentBox.id}
          mailbox={{ id: agentBox.id, address: agentBox.address }}
          onClose={() => setAgentDialogId(null)}
        />
      ) : null}
    </section>
  );
}
