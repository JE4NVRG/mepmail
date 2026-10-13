"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-recipient-unblock.module.css";
import shell from "./mailboxes.module.css";

function errorCode(error: unknown): string | null {
  return (error as { data?: { code?: string } } | null)?.data?.code ?? null;
}

/**
 * One blocked recipient: why it is blocked and, for a hard bounce, "Desbloquear" behind
 * a confirmation. A complaint (the person marked a message as spam) stays blocked. Only
 * a team owner or admin may lift a block; the server says so (FORBIDDEN) for anyone else.
 */
function BlockedRecipient({
  address,
  onUnblocked,
}: {
  address: string;
  onUnblocked: (address: string) => void;
}) {
  const t = useTranslations("mailboxes-blocks");
  const format = useFormatter();
  const trpc = useTRPC();
  const status = useQuery(
    trpc.mailboxes.recipientBlock.queryOptions({ address }, { retry: false, staleTime: 0 }),
  );
  const unblock = useMutation(trpc.mailboxes.unblockRecipient.mutationOptions({ retry: false }));
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ sesPending: boolean } | null>(null);
  const [error, setError] = useState("");

  async function lift() {
    setError("");
    try {
      const result = await unblock.mutateAsync({ address });
      // SES's own suppression list: still there (no permission yet, or unreachable).
      const sesPending = Object.values(result.ses ?? {}).some(
        (state) => state === "denied" || state === "unavailable",
      );
      setConfirming(false);
      setDone({ sesPending });
      onUnblocked(address);
    } catch (cause) {
      const code = errorCode(cause);
      setError(
        t(code === "FORBIDDEN" ? "forbidden" : code === "BAD_REQUEST" ? "invalid" : "error"),
      );
    }
  }

  let body: React.ReactNode;
  if (done) {
    body = (
      <>
        <p>{t("unblocked", { address })}</p>
        {done.sesPending ? <p className={styles.warning}>{t("sesPending")}</p> : null}
      </>
    );
  } else if (status.isPending) {
    body = <p>{t("checking", { address })}</p>;
  } else if (status.isError) {
    body = (
      <p>
        {errorCode(status.error) === "FORBIDDEN"
          ? t("adminOnly", { address })
          : t("checkError", { address })}
      </p>
    );
  } else if (!status.data.blocked) {
    body = <p>{t("notBlocked", { address })}</p>;
  } else if (status.data.reason === "complaint") {
    body = <p>{t("complaint", { address })}</p>;
  } else {
    const when = status.data.blockedAt
      ? format.dateTime(new Date(status.data.blockedAt), { dateStyle: "medium" })
      : null;
    body = confirming ? (
      <>
        <p>{t("confirm", { address })}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className="ms-btn ms-btn-sm"
            disabled={unblock.isPending}
            onClick={() => setConfirming(false)}
          >
            {t("keep")}
          </button>
          <button
            type="button"
            className="ms-btn ms-btn-primary ms-btn-sm"
            disabled={unblock.isPending}
            onClick={() => void lift()}
          >
            {unblock.isPending ? t("unblocking") : t("unblock")}
          </button>
        </div>
      </>
    ) : (
      <>
        <p>{when ? t("bounced", { address, date: when }) : t("bouncedUndated", { address })}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className="ms-btn ms-btn-sm"
            aria-label={t("unblockLabel", { address })}
            onClick={() => setConfirming(true)}
          >
            {t("unblock")}
          </button>
        </div>
      </>
    );
  }
  return (
    <li className={styles.recipient}>
      {body}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** The recipients a send was refused for (data.blockedRecipients), each one liftable. */
export function MailboxBlockedRecipients({
  addresses,
  onUnblocked,
}: {
  addresses: readonly string[];
  onUnblocked: (address: string) => void;
}) {
  if (!addresses.length) return null;
  return (
    <ul className={styles.list}>
      {addresses.map((address) => (
        <BlockedRecipient key={address} address={address} onUnblocked={onUnblocked} />
      ))}
    </ul>
  );
}

/** The composer's "Desbloquear" (from the refused-send toast): the same list in a dialog. */
export function MailboxBlockedRecipientsDialog({
  addresses,
  close,
}: {
  addresses: readonly string[];
  close: () => void;
}) {
  const t = useTranslations("mailboxes-blocks");
  const common = useTranslations("mailboxes");
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [lifted, setLifted] = useState<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const all = addresses.every((address) => lifted.includes(address));
  return (
    <dialog ref={dialog} className={shell.dialog} aria-labelledby={`${id}-title`} onClose={close}>
      <header className={shell.dialogHeader}>
        <h2 id={`${id}-title`}>{t("title")}</h2>
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          aria-label={common("close")}
          onClick={close}
        >
          ×
        </button>
      </header>
      <p className={styles.hint}>{t("hint")}</p>
      <MailboxBlockedRecipients
        addresses={addresses}
        onUnblocked={(address) => setLifted((current) => [...new Set([...current, address])])}
      />
      {all ? <p className={styles.hint}>{t("sendAgain")}</p> : null}
      <footer className={shell.dialogFooter}>
        <button type="button" className="ms-btn" onClick={close}>
          {common("close")}
        </button>
      </footer>
    </dialog>
  );
}
