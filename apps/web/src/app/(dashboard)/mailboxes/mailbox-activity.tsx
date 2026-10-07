"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-activity.module.css";
import registryStyles from "./mailboxes.module.css";

type Props = { mailbox: { id: string; address: string }; close: () => void };
const ACTION_KEYS = {
  "mailbox.items_listed": "actions.itemsListed",
  "mailbox.item_read": "actions.itemRead",
  "mailbox.draft_saved": "actions.draftSaved",
  "mailbox.send_approved": "actions.sendApproved",
  "mailbox.send_requested": "actions.sendRequested",
  "mailbox.item_trashed": "actions.itemTrashed",
  "mailbox.item_restored": "actions.itemRestored",
  "mailbox.item_starred": "actions.itemStarred",
  "mailbox.item_unstarred": "actions.itemUnstarred",
  "mailbox.item_folder_changed": "actions.itemFolderChanged",
  "mailbox.folder_created": "actions.folderCreated",
  "mailbox.folder_renamed": "actions.folderRenamed",
  "mailbox.folder_archived": "actions.folderArchived",
} as const;

export function MailboxActivityDialog(props: Props) {
  return <ActivitySession key={props.mailbox.id} {...props} />;
}

function ActivitySession({ mailbox, close }: Props) {
  const t = useTranslations("mailboxes-activity");
  const format = useFormatter();
  const trpc = useTRPC();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const active = useRef(true);
  const requesting = useRef(false);
  const query = useInfiniteQuery(
    trpc.mailboxes.activity.infiniteQueryOptions(
      { mailboxId: mailbox.id, limit: 25 },
      {
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    ),
  );
  const seen = new Set<string>();
  const items = query.isError
    ? []
    : (query.data?.pages.flatMap((page) => page.items) ?? []).filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    if (!element) return;
    if (!opener.current && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
    if (!element.open) element.showModal();
    heading.current?.focus();
    return () => {
      active.current = false;
      // Restore after unmount removes native modal inertness. StrictMode's
      // second setup sets active=true before this microtask can run.
      queueMicrotask(() => {
        if (!active.current && opener.current?.isConnected)
          opener.current.focus({ preventScroll: true });
      });
    };
  }, []);

  function dismiss() {
    if (!active.current) return;
    active.current = false;
    if (dialog.current?.open) dialog.current.close();
    close();
  }

  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const element = event.currentTarget;
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    const focused = element.ownerDocument.activeElement;
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (focused === first ||
        focused === heading.current ||
        focused === element ||
        !element.contains(focused))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (focused === last || !element.contains(focused))) {
      event.preventDefault();
      first.focus();
    }
  }

  async function request(older: boolean) {
    if (!active.current || requesting.current || query.isFetching || (older && !query.hasNextPage))
      return;
    requesting.current = true;
    try {
      if (older) await query.fetchNextPage({ throwOnError: true });
      else await query.refetch({ throwOnError: true });
    } catch {
      // Query error state hides stale rows, including when access was revoked.
    } finally {
      requesting.current = false;
      if (active.current)
        requestAnimationFrame(() => {
          if (active.current) feedback.current?.focus({ preventScroll: true });
        });
    }
  }

  return (
    <dialog
      ref={dialog}
      className={`${registryStyles.dialog} ${styles.dialog}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onKeyDown={keepFocus}
      onClose={dismiss}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <header className={`${registryStyles.dialogHeader} ${styles.header}`}>
        <div>
          <p className={styles.eyebrow}>{t("eyebrow")}</p>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
            {t("title")}
          </h2>
          <p className={styles.address}>{mailbox.address}</p>
        </div>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          onClick={dismiss}
          aria-label={t("close")}
        >
          ×
        </button>
      </header>
      <p id={`${id}-description`} className={styles.description}>
        {t("description")}
      </p>
      <div className={styles.toolbar}>
        <p className={styles.historyStart}>{t("historyStart")}</p>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={query.isFetching}
          onClick={() => void request(false)}
        >
          {t(query.isRefetching ? "refreshing" : "refresh")}
        </button>
      </div>
      <section className={styles.history} aria-label={t("title")} aria-busy={query.isFetching}>
        {query.isError ? (
          <p className={styles.feedback} ref={feedback} tabIndex={-1} role="alert">
            {t("error")}
          </p>
        ) : query.isPending ? (
          <p className={styles.feedback} role="status">
            {t("loading")}
          </p>
        ) : items.length ? (
          <>
            <ol className={styles.timeline}>
              {items.map((item) => (
                <li key={item.id}>
                  <div className={styles.eventHeading}>
                    <strong>{item.actor.label?.trim() || t(`actors.${item.actor.kind}`)}</strong>
                    {item.actor.label?.trim() ? (
                      <span className={styles.actorKind}>{t(`actors.${item.actor.kind}`)}</span>
                    ) : null}
                  </div>
                  <p className={styles.action}>{t(ACTION_KEYS[item.action])}</p>
                  <div className={styles.eventDetails}>
                    <time dateTime={item.createdAt.toISOString()}>
                      {format.dateTime(item.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                    </time>
                    {item.folder ? <span>{t(`folders.${item.folder}`)}</span> : null}
                    {item.count !== undefined ? (
                      <span>{t("messageCount", { count: item.count })}</span>
                    ) : null}
                    {item.revision !== undefined ? (
                      <span>{t("revision", { revision: item.revision })}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <p ref={feedback} tabIndex={-1} className={styles.loaded} role="status">
              {t("loadedCount", { count: items.length })}
            </p>
            {query.hasNextPage ? (
              <button
                type="button"
                className={`ms-btn ms-btn-ghost ${styles.older}`}
                disabled={query.isFetching}
                onClick={() => void request(true)}
              >
                {t(query.isFetchingNextPage ? "loadingOlder" : "older")}
              </button>
            ) : null}
          </>
        ) : (
          <div className={styles.empty}>
            <p ref={feedback} tabIndex={-1} role="status">
              {t("empty")}
            </p>
          </div>
        )}
      </section>
      <footer className={styles.footer}>
        <p>{t("privacy")}</p>
        <button type="button" className="ms-btn ms-btn-ghost" onClick={dismiss}>
          {t("close")}
        </button>
      </footer>
    </dialog>
  );
}
