"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { NavGlyph } from "@/components/icons/nav-icons";
import { authClient } from "@/lib/auth-client";
import type { MailboxFolder, MailboxKindFilter } from "@/lib/mailbox-inbox-presentation";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import { MailboxActivityDialog } from "./mailbox-activity";
import { MailboxAgentKeysDialog } from "./mailbox-agent-keys";
import { MailboxContentView } from "./mailbox-content-view";
import { MailboxFolderDialog } from "./mailbox-folder-dialog";
import { MailboxFolderIcon } from "./mailbox-folder-icon";
import managementStyles from "./mailbox-management.module.css";
import { MailboxOffer } from "./mailbox-offer";
import { MailboxServicePanel } from "./mailbox-service-panel";
import { MailboxSetupDialog } from "./mailbox-setup-dialog";
import { MailboxUsagePanel } from "./mailbox-usage-panel";
import styles from "./mailboxes.module.css";

type Outputs = inferRouterOutputs<AppRouter>["mailboxes"];
type Box = Outputs["list"]["mailboxes"][number];
type Options = Outputs["options"];

function RegistryDialog({
  mailbox,
  options,
  close,
  changed,
  openReceiving,
}: {
  mailbox: Box | null;
  options: Options;
  close: () => void;
  changed: (id: string) => Promise<void>;
  openReceiving: () => void;
}) {
  const t = useTranslations("mailboxes");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const [domainId, setDomain] = useState(options.domains[0]?.id ?? "");
  const [owner, setOwner] = useState(mailbox?.ownerUserId ?? options.currentUserId);
  const [label, setLabel] = useState(mailbox?.label ?? "");
  const [signatureText, setSignatureText] = useState(mailbox?.signatureText ?? "");
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
              ? await update.mutateAsync({
                  id: mailbox.id,
                  label,
                  ownerUserId: owner,
                  status,
                  signatureText,
                })
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
            <>
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
              <label>
                {t("signatureLabel")}
                <textarea
                  className={`ms-input ${managementStyles.signatureInput}`}
                  value={signatureText}
                  onChange={(event) => setSignatureText(event.target.value)}
                  maxLength={4000}
                  rows={4}
                  placeholder={t("signaturePlaceholder")}
                  aria-describedby="mailbox-signature-help"
                />
                <small id="mailbox-signature-help" className={managementStyles.signatureHelp}>
                  {t("signatureHelp")}
                </small>
              </label>
            </>
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
        <div className={styles.dialogFooter}>
          <button type="button" className="ms-btn" disabled={busy} onClick={openReceiving}>
            {t("setup.checkReceiving")}
          </button>
        </div>
      ) : null}
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

/**
 * Correio's whole UI. `dashboard` is the legacy embedded page; `app` is the
 * standalone full-screen inbox at /mail (opened from the menu in its own tab);
 * `settings` is its companion page at /mail/settings: mailboxes, agents and
 * the license, with the same dialogs.
 */
export function MailboxesView({
  correioMcpUrl,
  layout = "dashboard",
}: {
  correioMcpUrl?: string;
  layout?: "dashboard" | "app" | "settings";
} = {}) {
  const t = useTranslations("mailboxes");
  const tActivity = useTranslations("mailboxes-activity");
  const { data: session } = authClient.useSession();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const capability = useQuery(trpc.mailboxes.capabilities.queryOptions());
  // Start with the capability check instead of after it: one round trip less on
  // open. A team without access gets NOT_FOUND once and the queries stop.
  const mayUseMail = capability.data?.enabled !== false;
  const service = useQuery(
    trpc.mailboxes.service.queryOptions(undefined, {
      enabled: mayUseMail,
      retry: false,
    }),
  );
  const systemLicense =
    !service.isPending && !service.isError && service.data?.licenseKind === "system";
  const registry = useQuery(
    trpc.mailboxes.list.queryOptions(undefined, {
      enabled: mayUseMail,
      refetchInterval: 15000,
      retry: (count, error) =>
        (error as { data?: { code?: string } }).data?.code !== "NOT_FOUND" && count < 3,
    }),
  );
  const options = useQuery(
    trpc.mailboxes.options.queryOptions(undefined, { enabled: registry.data?.canManage === true }),
  );
  const [selectedId, select] = useState<string | null>(null);
  const [itemSelection, selectItem] = useState<{ mailboxId: string; id: string } | null>(null);
  const [folder, setFolder] = useState<MailboxFolder>("inbox");
  const [customFolderId, setCustomFolderId] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<string | "new" | null>(null);
  const [mailboxKind, setMailboxKind] = useState<MailboxKindFilter>("all");
  const [dialog, setDialog] = useState<"new" | "edit" | "receiving" | null>(null);
  const [licenseOpenRequest, openLicense] = useState(0);
  const [licenseOfferId, setLicenseOfferId] = useState<string | null>(null);
  const [agentDialogId, setAgentDialogId] = useState<string | null>(null);
  const [activityDialogId, setActivityDialogId] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<"boxes" | "agents" | "license">("boxes");
  const managementMenu = useRef<HTMLDetailsElement>(null);
  // Team switches cause a full navigation. Every id is also resolved against this request's scoped DTO.
  const boxes = registry.data?.mailboxes ?? [];
  const scopedBoxes = boxes.filter((box) => mailboxKind === "all" || box.kind === mailboxKind);
  const selected = boxes.find((b) => b.id === selectedId) ?? null;
  const folderList = useQuery(
    trpc.mailboxes.folders.queryOptions(
      { mailboxId: selected?.id ?? "00000000-0000-0000-0000-000000000000" },
      { enabled: !!selected?.canRead && selected.status === "planned", retry: false },
    ),
  );
  const canOrganize = !!selected?.ownerActive && selected.ownerUserId === session?.user.id;
  const agentBox = boxes.find(
    (box) => box.id === agentDialogId && box.ownerActive && box.ownerUserId === session?.user.id,
  );
  const activityBox = boxes.find(
    (box) =>
      box.id === activityDialogId &&
      box.canRead &&
      box.status === "planned" &&
      box.ownerActive &&
      box.ownerUserId === session?.user.id,
  );
  function selectMailbox(id: string | null) {
    selectItem(null);
    select(id);
    setCustomFolderId(null);
    setFolderDialog(null);
    if (folder === "custom") setFolder("inbox");
  }
  function chooseFolder(next: MailboxFolder, id: string | null = null) {
    selectItem(null);
    setFolder(next);
    setCustomFolderId(id);
  }
  function changeScope(kind: MailboxKindFilter) {
    setMailboxKind(kind);
    selectMailbox(null);
  }
  async function changed(id: string) {
    await Promise.all([
      queries.invalidateQueries({ queryKey: trpc.mailboxes.list.queryKey() }),
      queries.invalidateQueries({ queryKey: trpc.mailboxes.service.queryKey() }),
    ]);
    setMailboxKind("all");
    selectMailbox(id);
  }
  if (capability.isPending) return <p aria-live="polite">{t("loading")}</p>;
  if (!capability.isError && !capability.data?.enabled)
    return capability.data?.offered ? (
      <MailboxOffer />
    ) : (
      <section>
        <h1>{t("title")}</h1>
        <p>{t("disabled")}</p>
      </section>
    );
  if (!capability.isError && registry.isPending) return <p aria-live="polite">{t("loading")}</p>;
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
  const navigation = (
    <div className={styles.workspaceNavigation}>
      <nav className={styles.scopeFilters} aria-label={t("scope.label")}>
        {(["all", "person", "agent"] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            aria-pressed={mailboxKind === kind}
            onClick={() => changeScope(kind)}
          >
            {t(`scope.${kind}`)}
          </button>
        ))}
      </nav>
      <label>
        <span className={styles.visuallyHidden}>{t("chooseBox")}</span>
        <select
          className="ms-input"
          aria-label={t("chooseBox")}
          value={selected?.id ?? ""}
          onChange={(e) => selectMailbox(e.target.value || null)}
        >
          <option value="">{t(`scope.boxes.${mailboxKind}`)}</option>
          {(["person", "agent"] as const).map((kind) => {
            const group = scopedBoxes.filter((box) => box.kind === kind);
            return group.length ? (
              <optgroup key={kind} label={t(`scope.${kind}`)}>
                {group.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.label} · {box.address}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </label>
      <nav className={styles.compactFolders} aria-label={t("folders")}>
        {(["inbox", "favorites", "drafts", "sent", "spam", "quarantine", "trash"] as const).map(
          (f) => (
            <button
              type="button"
              key={f}
              aria-current={f === folder ? "page" : undefined}
              onClick={() => chooseFolder(f)}
            >
              <MailboxFolderIcon name={f} />
              {t(f)}
            </button>
          ),
        )}
      </nav>
      <section className={styles.customFolders} aria-label={t("organization.folders")}>
        <header>
          <h3>{t("organization.folders")}</h3>
          {canOrganize && selected?.canRead ? (
            <button
              type="button"
              aria-label={t("organization.createFolder")}
              onClick={() => setFolderDialog("new")}
            >
              +
            </button>
          ) : null}
        </header>
        {!selected ? (
          <p>{t("organization.chooseBox")}</p>
        ) : folderList.isError ? (
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            onClick={() => void folderList.refetch()}
          >
            {t("retry")}
          </button>
        ) : folderList.isPending ? (
          <p>{t("loading")}</p>
        ) : folderList.data?.length ? (
          folderList.data.map((entry) => (
            <div className={styles.customFolderRow} key={entry.id}>
              <button
                type="button"
                title={entry.name}
                aria-current={
                  folder === "custom" && customFolderId === entry.id ? "page" : undefined
                }
                onClick={() => chooseFolder("custom", entry.id)}
              >
                <MailboxFolderIcon name="custom" />
                <span>{entry.name}</span>
              </button>
              {canOrganize ? (
                <button
                  type="button"
                  aria-label={t("organization.manageFolder", { name: entry.name })}
                  onClick={() => setFolderDialog(entry.id)}
                >
                  ···
                </button>
              ) : null}
            </div>
          ))
        ) : (
          <p>{t("organization.emptyFolders")}</p>
        )}
      </section>
      <MailboxUsagePanel mailboxId={selected?.id ?? null} />
    </div>
  );
  const workspace = (
    <div className={styles.workspace}>
      {(!selected || (selected.canRead && selected.status === "planned")) &&
      scopedBoxes.some((b) => b.canRead && b.status === "planned") ? (
        <MailboxContentView
          key={`${mailboxKind}:${selected?.id ?? "all"}`}
          navigation={navigation}
          boxes={boxes}
          selected={selected}
          mailboxKind={mailboxKind === "all" ? undefined : mailboxKind}
          currentUserId={session?.user.id}
          folder={folder}
          customFolderId={customFolderId}
          customFolderName={
            folderList.data?.find((entry) => entry.id === customFolderId)?.name ?? null
          }
          changeFolder={chooseFolder}
          selection={itemSelection}
          select={selectItem}
          draftSaved={(saved) => {
            setMailboxKind("all");
            select(saved.mailboxId);
            setFolder("drafts");
            selectItem({ mailboxId: saved.mailboxId, id: saved.id });
          }}
        />
      ) : (
        <div className={styles.registryWorkspace}>
          <header className={styles.contentToolbar}>{navigation}</header>
          <div className={styles.registryState}>
            <div className={styles.hero}>
              <NavGlyph name="emails" hovered={false} />
              <h2>
                {selected?.label ??
                  t(mailboxKind === "all" ? "emptyTitle" : `scope.empty.${mailboxKind}.title`)}
              </h2>
              {selected ? (
                <>
                  <p className={styles.address}>{selected.address}</p>
                  <span className={styles.tag}>{t(selected.status)}</span>
                  <p>{t(selected.status === "suspended" ? "pausedBody" : "preparingBody")}</p>
                  {!selected.ownerActive ? (
                    <p className={styles.hint}>{t("ownerMissing")}</p>
                  ) : null}
                  {!selected.canRead ? <p className={styles.hint}>{t("managementOnly")}</p> : null}
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
                  <p>
                    {t(mailboxKind === "all" ? "emptyBody" : `scope.empty.${mailboxKind}.body`)}
                  </p>
                  {registry.data?.canManage && options.data ? (
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
  );
  const dialogs = (
    <>
      {registry.data?.canManage && dialog === "new" && options.data ? (
        <MailboxSetupDialog
          options={options.data}
          close={() => setDialog(null)}
          changed={changed}
          reviewLicense={(offerId) => {
            setDialog(null);
            setLicenseOfferId(offerId ?? null);
            openLicense((request) => request + 1);
          }}
        />
      ) : null}
      {registry.data?.canManage && dialog === "edit" && options.data && selected ? (
        <RegistryDialog
          key={selected.id}
          mailbox={selected}
          options={options.data}
          close={() => setDialog(null)}
          changed={changed}
          openReceiving={() => setDialog("receiving")}
        />
      ) : null}
      {registry.data?.canManage && dialog === "receiving" && options.data && selected ? (
        <MailboxSetupDialog
          key={`receiving-${selected.id}`}
          existingMailbox={selected}
          options={options.data}
          close={() => setDialog(null)}
          changed={changed}
          reviewLicense={(offerId) => {
            setDialog(null);
            setLicenseOfferId(offerId ?? null);
            openLicense((request) => request + 1);
          }}
        />
      ) : null}
      {agentBox ? (
        <MailboxAgentKeysDialog
          key={agentBox.id}
          mailbox={{ id: agentBox.id, address: agentBox.address }}
          onClose={() => setAgentDialogId(null)}
          mcpUrl={correioMcpUrl}
        />
      ) : null}
      {activityBox ? (
        <MailboxActivityDialog
          key={activityBox.id}
          mailbox={{ id: activityBox.id, address: activityBox.address }}
          close={() => setActivityDialogId(null)}
        />
      ) : null}
      {folderDialog &&
      selected &&
      canOrganize &&
      (folderDialog === "new" || folderList.data?.some((entry) => entry.id === folderDialog)) ? (
        <MailboxFolderDialog
          key={`${selected.id}:${folderDialog}`}
          mailboxId={selected.id}
          folder={
            folderDialog === "new"
              ? null
              : (folderList.data?.find((entry) => entry.id === folderDialog) ?? null)
          }
          close={() => setFolderDialog(null)}
          changed={(id) => chooseFolder(id ? "custom" : "inbox", id)}
        />
      ) : null}
    </>
  );
  const ownsSelected = !!selected?.ownerActive && selected.ownerUserId === session?.user.id;
  const ownedBoxes = boxes.filter((box) => box.ownerActive && box.ownerUserId === session?.user.id);
  if (layout !== "dashboard")
    return (
      <section className={`${styles.view} ${styles.appView}`}>
        <header className={styles.appBar}>
          <Link href="/mail" className={styles.appBrand}>
            <NavGlyph name="emails" hovered={false} />
            <span>{t("title")}</span>
          </Link>
          <span className={styles.serviceBadge}>
            {t(systemLicense ? "system.badge" : "paidService")}
          </span>
          <nav className={styles.appTabs} aria-label={t("app.sections")}>
            <Link href="/mail" aria-current={layout === "app" ? "page" : undefined}>
              {t("app.inbox")}
            </Link>
            <Link href="/mail/settings" aria-current={layout === "settings" ? "page" : undefined}>
              {t("app.settings")}
            </Link>
          </nav>
          <div className={styles.appActions}>
            {layout === "app" &&
            selected?.canRead &&
            selected.status === "planned" &&
            ownsSelected ? (
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                onClick={() => setActivityDialogId(selected.id)}
              >
                {tActivity("open")}
              </button>
            ) : null}
            {layout === "app" && selected && ownsSelected ? (
              <button
                type="button"
                className="ms-btn ms-btn-ghost"
                onClick={() => setAgentDialogId(selected.id)}
              >
                {t("connectAgent")}
              </button>
            ) : null}
            {registry.data?.canManage ? (
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={!options.data}
                onClick={() => setDialog("new")}
              >
                + {t("new")}
              </button>
            ) : null}
            <Link className="ms-btn ms-btn-ghost" href="/emails">
              {t("app.back")}
            </Link>
          </div>
        </header>
        {layout === "app" ? (
          <>
            {licenseOpenRequest > 0 ? (
              <MailboxServicePanel
                openRequest={licenseOpenRequest}
                initialOfferId={licenseOfferId}
              />
            ) : null}
            {workspace}
          </>
        ) : (
          <div className={styles.settings}>
            <div className={styles.settingsTabs} role="tablist" aria-label={t("app.settings")}>
              {(["boxes", "agents", "license"] as const).map((tab) => (
                <button
                  type="button"
                  role="tab"
                  key={tab}
                  aria-selected={settingsTab === tab}
                  onClick={() => setSettingsTab(tab)}
                >
                  {t(`app.tabs.${tab}`)}
                </button>
              ))}
            </div>
            {settingsTab === "boxes" ? (
              <section className={styles.settingsSection} aria-label={t("app.tabs.boxes")}>
                <p className={styles.hint}>{t("app.boxesHint")}</p>
                {registry.data?.canManage && options.data && !options.data.domains.length ? (
                  <p className={styles.notice}>
                    {t("noDomains")} <Link href="/domains">{t("domainsLink")} ↗</Link>
                  </p>
                ) : null}
                {boxes.length ? (
                  <ul className={styles.settingsList}>
                    {boxes.map((box) => (
                      <li key={box.id}>
                        <div>
                          <strong>{box.label}</strong>
                          <span>{box.address}</span>
                          <small>
                            {t(`scope.${box.kind}`)} · {t(box.status)}
                          </small>
                        </div>
                        {registry.data?.canManage ? (
                          <div className={styles.settingsRowActions}>
                            <button
                              type="button"
                              className="ms-btn ms-btn-ghost"
                              disabled={!options.data}
                              onClick={() => {
                                selectMailbox(box.id);
                                setDialog("receiving");
                              }}
                            >
                              {t("app.receiving")}
                            </button>
                            <button
                              type="button"
                              className="ms-btn"
                              disabled={!options.data}
                              onClick={() => {
                                selectMailbox(box.id);
                                setDialog("edit");
                              }}
                            >
                              {t("manage")}
                            </button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("emptyBody")}</p>
                )}
                {registry.data?.canManage ? (
                  <Link className="ms-btn ms-btn-ghost" href="/domains">
                    {t("domainsLink")}
                  </Link>
                ) : null}
              </section>
            ) : settingsTab === "agents" ? (
              <section className={styles.settingsSection} aria-label={t("app.tabs.agents")}>
                <p className={styles.hint}>{t("app.agentsHint")}</p>
                {ownedBoxes.length ? (
                  <ul className={styles.settingsList}>
                    {ownedBoxes.map((box) => (
                      <li key={box.id}>
                        <div>
                          <strong>{box.label}</strong>
                          <span>{box.address}</span>
                          <small>{t(`scope.${box.kind}`)}</small>
                        </div>
                        <div className={styles.settingsRowActions}>
                          {box.canRead && box.status === "planned" ? (
                            <button
                              type="button"
                              className="ms-btn ms-btn-ghost"
                              onClick={() => setActivityDialogId(box.id)}
                            >
                              {tActivity("open")}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="ms-btn"
                            onClick={() => setAgentDialogId(box.id)}
                          >
                            {t("connectAgent")}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t("app.agentsEmpty")}</p>
                )}
              </section>
            ) : (
              <section className={styles.settingsSection} aria-label={t("app.tabs.license")}>
                <MailboxServicePanel
                  openRequest={licenseOpenRequest}
                  initialOfferId={licenseOfferId}
                />
                <MailboxUsagePanel mailboxId={null} />
              </section>
            )}
          </div>
        )}
        {dialogs}
      </section>
    );
  return (
    <section className={styles.view}>
      <header className={`${styles.header} ${managementStyles.header}`}>
        <div>
          <div className={styles.productMeta}>
            <h1>{t("title")}</h1>
            <span className={styles.serviceBadge}>
              {t(systemLicense ? "system.badge" : "paidService")}
            </span>
          </div>
          <p>{t("subtitle")}</p>
        </div>
        <div className={`${styles.headerActions} ${managementStyles.actions}`}>
          {selected?.canRead &&
          selected.status === "planned" &&
          selected.ownerActive &&
          selected.ownerUserId === session?.user.id ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => setActivityDialogId(selected.id)}
            >
              {tActivity("open")}
            </button>
          ) : null}
          {selected?.ownerActive && selected.ownerUserId === session?.user.id ? (
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              onClick={() => setAgentDialogId(selected.id)}
            >
              {t("connectAgent")}
            </button>
          ) : null}
          {registry.data?.canManage ? (
            <>
              <Link className="ms-btn ms-btn-ghost" href="/domains">
                {t("domainsLink")}
              </Link>
              {selected ? (
                <button
                  type="button"
                  className="ms-btn"
                  disabled={!options.data}
                  onClick={() => setDialog("edit")}
                >
                  {t("manage")}
                </button>
              ) : (
                <details ref={managementMenu} className={managementStyles.menu}>
                  <summary className={`ms-btn ${managementStyles.menuTrigger}`}>
                    {t("manage")}
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path d="m4 6 4 4 4-4" />
                    </svg>
                  </summary>
                  <div className={managementStyles.menuBody}>
                    {boxes.length ? (
                      <label className={managementStyles.chooser}>
                        {t("chooseBox")}
                        <select
                          className="ms-input"
                          value=""
                          disabled={!options.data}
                          onChange={(event) => {
                            const id = event.target.value;
                            if (!options.data || !boxes.some((box) => box.id === id)) return;
                            if (managementMenu.current) managementMenu.current.open = false;
                            setMailboxKind("all");
                            selectMailbox(id);
                            setDialog("edit");
                          }}
                        >
                          <option value="">{t("chooseBox")}</option>
                          {boxes.map((box) => (
                            <option key={box.id} value={box.id}>
                              {box.label} · {box.address}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p>{t("emptyTitle")}</p>
                    )}
                  </div>
                </details>
              )}
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={!options.data}
                onClick={() => setDialog("new")}
              >
                + {t("new")}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {capability.data?.deliveryReady ? (
        <p className={styles.previewNote}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          {t("contentPrivate")}
        </p>
      ) : (
        <p className={styles.previewNote}>
          <span>{t("preview")}</span> {t("previewBody")}
        </p>
      )}
      <MailboxServicePanel openRequest={licenseOpenRequest} initialOfferId={licenseOfferId} />
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
      {workspace}
      {dialogs}
    </section>
  );
}
