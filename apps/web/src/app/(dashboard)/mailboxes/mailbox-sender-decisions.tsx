"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Select } from "@/components/select";
import { toast } from "@/components/toast";
import { useTRPC } from "@/lib/trpc";
import { MailboxSenderList } from "./mailbox-sender-bar";
import styles from "./mailbox-senders.module.css";

type Decision = "allow" | "block";
type Filter = "all" | Decision;

/** A list this long shows a page at a time, with a search on top. */
const PAGE = 50;
const SEARCH_FROM = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Preferências → "Remetentes aprovados e bloqueados": for each mailbox the
 * person owns, the answers given in the bar above new senders, newest first.
 * An answer can be switched (approve ↔ block) or forgotten, with "Desfazer",
 * and an address can be answered ahead of its first message. Answers apply to
 * the next messages only; mail already received stays where it is.
 */
export function MailboxSenderDecisions({
  boxes,
  preferredId,
}: {
  /** The mailboxes this person owns (only an owner answers for a mailbox). */
  boxes: { id: string; label: string; address: string }[];
  /** The mailbox open in the inbox, shown first when it is one of them. */
  preferredId?: string | null;
}) {
  const t = useTranslations("mailboxes.senders");
  const id = useId();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const [mailboxId, setMailboxId] = useState(
    () => boxes.find((box) => box.id === preferredId)?.id ?? boxes[0]?.id ?? "",
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // A mailbox that is no longer the person's falls back to the first one.
  useEffect(() => {
    if (!boxes.some((box) => box.id === mailboxId)) setMailboxId(boxes[0]?.id ?? "");
  }, [boxes, mailboxId]);
  // Another mailbox, another list: start again from the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on mailbox change only.
  useEffect(() => {
    setFilter("all");
    setQuery("");
    setShown(PAGE);
  }, [mailboxId]);

  const list = useQuery(
    trpc.mailboxes.senders.list.queryOptions(
      { mailboxId },
      { enabled: !!mailboxId, staleTime: 30_000, retry: 1 },
    ),
  );
  const decide = useMutation(trpc.mailboxes.senders.decide.mutationOptions({ retry: false }));

  if (!boxes.length) return null;

  const entries = list.data ?? [];
  const folded = query.trim().toLowerCase();
  const matching = entries.filter(
    (entry) =>
      (filter === "all" || entry.decision === filter) &&
      (!folded || entry.address.includes(folded)),
  );
  const counts = {
    all: entries.length,
    allow: entries.filter((entry) => entry.decision === "allow").length,
    block: entries.filter((entry) => entry.decision === "block").length,
  };

  async function change(address: string, decision: Decision | null, previous?: Decision | null) {
    setBusy(address);
    try {
      await decide.mutateAsync({ mailboxId, address, decision });
    } catch (error) {
      const code = error instanceof TRPCClientError ? error.data?.code : null;
      toast(
        code === "CONFLICT"
          ? t("limit")
          : code === "PRECONDITION_FAILED"
            ? t("unavailable")
            : t("error"),
        "danger",
      );
      return false;
    } finally {
      setBusy(null);
    }
    await list.refetch();
    // List rows carry the answer (senderDecision): read them again.
    void queries.invalidateQueries({ queryKey: trpc.mailboxes.items.pathKey() });
    const message =
      decision === null
        ? t("forgotNotice", { address })
        : decision === "allow"
          ? t("allowedOne", { address })
          : t("blockedOne", { address });
    toast(
      message,
      "success",
      previous !== undefined
        ? { action: { label: t("undo"), run: () => void change(address, previous) } }
        : {},
    );
    return true;
  }

  async function add(decision: Decision) {
    const address = draft.trim().toLowerCase();
    if (!EMAIL.test(address) || address.length > 320) {
      setDraftError(t("invalid"));
      return;
    }
    setDraftError(null);
    const previous = entries.find((entry) => entry.address === address)?.decision ?? null;
    if (await change(address, decision, previous)) setDraft("");
  }

  const filters: { value: Filter; label: string }[] = [
    { value: "all", label: t("filterAll", { count: counts.all }) },
    { value: "allow", label: t("filterAllowed", { count: counts.allow }) },
    { value: "block", label: t("filterBlocked", { count: counts.block }) },
  ];

  return (
    <div className={styles.decisions}>
      {boxes.length > 1 ? (
        <div className={styles.decisionsBox}>
          <label htmlFor={`${id}-box`}>{t("mailbox")}</label>
          <Select
            id={`${id}-box`}
            ariaLabel={t("mailbox")}
            value={mailboxId}
            width={280}
            onChange={setMailboxId}
            options={boxes.map((box) => ({
              value: box.id,
              label: `${box.label} · ${box.address}`,
            }))}
          />
        </div>
      ) : (
        <p className={styles.listHint}>{boxes[0]?.address}</p>
      )}
      <p className={styles.listHint}>{t("listHint")}</p>

      <form
        className={styles.addSender}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void add("block");
        }}
        noValidate
      >
        <input
          type="email"
          className="ms-input"
          aria-label={t("addLabel")}
          aria-invalid={draftError ? true : undefined}
          aria-describedby={draftError ? `${id}-add-error` : undefined}
          placeholder={t("addPlaceholder")}
          value={draft}
          maxLength={320}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            if (draftError) setDraftError(null);
          }}
        />
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={!draft.trim() || busy !== null}
          onClick={() => void add("allow")}
        >
          {t("allow")}
        </button>
        <button
          type="submit"
          className="ms-btn ms-btn-ghost"
          disabled={!draft.trim() || busy !== null}
        >
          {t("block")}
        </button>
      </form>
      {draftError ? (
        <p id={`${id}-add-error`} role="alert" className={styles.addError}>
          {draftError}
        </p>
      ) : null}

      {entries.length >= SEARCH_FROM ? (
        <div className={styles.decisionsTools}>
          <fieldset className={styles.decisionsFilters} aria-label={t("filterLabel")}>
            {filters.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => {
                  setFilter(option.value);
                  setShown(PAGE);
                }}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
          <input
            type="search"
            className="ms-input"
            aria-label={t("search")}
            placeholder={t("search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShown(PAGE);
            }}
          />
        </div>
      ) : null}

      {list.isError ? (
        <p className={styles.listHint} role="alert">
          {t("loadError")}{" "}
          <button type="button" className="ms-btn ms-btn-ghost" onClick={() => void list.refetch()}>
            {t("retry")}
          </button>
        </p>
      ) : entries.length && !matching.length ? (
        <p className={styles.listHint}>{t("noMatch")}</p>
      ) : (
        <MailboxSenderList
          entries={matching.slice(0, shown)}
          loading={list.isPending}
          busyAddress={busy}
          onClear={(address) =>
            void change(
              address,
              null,
              entries.find((entry) => entry.address === address)?.decision ?? null,
            )
          }
          onSwitch={(address, decision) =>
            void change(address, decision, decision === "allow" ? "block" : "allow")
          }
        />
      )}
      {matching.length > shown ? (
        <button
          type="button"
          className={`ms-btn ms-btn-ghost ${styles.showMore}`}
          onClick={() => setShown((value) => value + PAGE)}
        >
          {t("showMore", { count: matching.length - shown })}
        </button>
      ) : null}
    </div>
  );
}
