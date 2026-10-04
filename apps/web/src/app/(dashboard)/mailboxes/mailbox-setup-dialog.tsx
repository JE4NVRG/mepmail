"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { DOCS_URL } from "@/lib/docs-links";
import {
  mailboxHasUnlimitedSeats,
  mailboxSetupFailure,
  mailboxSetupLocalPart,
  mailboxSetupSeatState,
} from "@/lib/mailbox-setup";
import { useTRPC } from "@/lib/trpc";
import type { AppRouter } from "@/server/routers";
import styles from "./mailbox-setup-dialog.module.css";

type Options = inferRouterOutputs<AppRouter>["mailboxes"]["options"];

export function MailboxSetupDialog({
  options,
  close,
  changed,
  reviewLicense,
}: {
  options: Options;
  close: () => void;
  changed: (id: string) => Promise<void>;
  reviewLicense: () => void;
}) {
  const t = useTranslations("mailboxes.setup");
  const trpc = useTRPC();
  const queries = useQueryClient();
  const service = useQuery(trpc.mailboxes.service.queryOptions(undefined, { retry: false }));
  const create = useMutation(trpc.mailboxes.create.mutationOptions());
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [step, setStep] = useState(0);
  const [domainId, setDomainId] = useState(
    options.domains.find((domain) => domain.status === "verified")?.id ??
      options.domains[0]?.id ??
      "",
  );
  const [local, setLocal] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"person" | "agent">("person");
  const [ownerId, setOwnerId] = useState(options.currentUserId);
  const [error, setError] = useState<
    ReturnType<typeof mailboxSetupFailure> | "addressInvalid" | "ownerInvalid" | null
  >(null);
  const [saved, setSaved] = useState<{ id: string; address: string } | null>(null);
  const domain = options.domains.find((entry) => entry.id === domainId);
  const owner = options.members.find((member) => member.id === ownerId);
  const normalized = mailboxSetupLocalPart(local);
  const address = `${normalized ?? (local.trim() || t("exampleLocal"))}@${domain?.name ?? t("exampleDomain")}`;
  const seatState = mailboxSetupSeatState(service.data, service.isPending, service.isError);
  const systemUnlimited = seatState === "ready" && mailboxHasUnlimitedSeats(service.data);
  const busy = create.isPending;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (step > 0 || saved) heading.current?.focus();
  }, [step, saved]);

  function advance() {
    if (!normalized || !domain) {
      setError("addressInvalid");
      return;
    }
    if (step > 0 && !owner) {
      setError("ownerInvalid");
      return;
    }
    setError(null);
    setStep((current) => Math.min(2, current + 1));
  }

  async function submit() {
    if (busy || saved) return;
    if (step < 2) {
      advance();
      return;
    }
    if (!normalized || !domain) {
      setError("addressInvalid");
      return;
    }
    if (!owner) {
      setError("ownerInvalid");
      return;
    }
    if (seatState !== "ready") return;
    setError(null);
    try {
      const result = await create.mutateAsync({
        domainId,
        localPart: normalized,
        label: label.trim() || normalized,
        kind,
        ownerUserId: ownerId,
      });
      // Preserve a confirmed reservation even if a following query refresh fails.
      setSaved({ id: result.id, address: `${normalized}@${domain.name}` });
      await Promise.allSettled([
        changed(result.id),
        queries.invalidateQueries({ queryKey: trpc.mailboxes.service.queryKey() }),
      ]);
    } catch (cause) {
      setError(mailboxSetupFailure(cause));
      void service.refetch();
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={close}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{t("eyebrow")}</p>
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {t(saved ? "savedTitle" : "title")}
          </h2>
        </div>
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
      <p id={descriptionId} className={styles.description}>
        {t(saved ? "savedDescription" : "description")}
      </p>
      {saved ? (
        <section className={styles.success}>
          <p className={styles.address}>{saved.address}</p>
          <h3>{t("nextTitle")}</h3>
          <p>{t("nextBody")}</p>
          {kind === "agent" ? <p>{t("agentNext")}</p> : null}
          <div className={styles.successActions}>
            <Link className="ms-btn" href={`/domains/${domainId}`}>
              {t("viewDomain")}
            </Link>
            <a className="ms-btn" href={`${DOCS_URL}/mailboxes`} target="_blank" rel="noreferrer">
              {t("guide")}
            </a>
            <button type="button" className="ms-btn ms-btn-primary" onClick={close}>
              {t("viewMailbox")}
            </button>
          </div>
        </section>
      ) : (
        <>
          <ol className={styles.steps} aria-label={t("stepsLabel")}>
            {(["addressStep", "usageStep", "reviewStep"] as const).map((name, index) => (
              <li
                key={name}
                aria-current={index === step ? "step" : undefined}
                data-complete={index < step}
              >
                <span
                  aria-hidden="true"
                  className={`${styles.stepNumber} ${index === step ? styles.activeStepNumber : index < step ? styles.completeStepNumber : ""}`}
                >
                  {index + 1}
                </span>
                {t(name)}
              </li>
            ))}
          </ol>
          {seatState !== "ready" ? (
            <div className={styles.notice} role={seatState === "error" ? "alert" : "status"}>
              <div>
                <strong>{t(`seats.${seatState}.title`)}</strong>
                <p>
                  {t(`seats.${seatState}.body`, {
                    used: service.data?.reservedSeats ?? 0,
                    total: service.data?.seats ?? 0,
                  })}
                </p>
              </div>
              {seatState === "loading" ? null : seatState === "error" ? (
                <button
                  type="button"
                  className="ms-btn"
                  disabled={service.isFetching}
                  onClick={() => void service.refetch()}
                >
                  {t("retry")}
                </button>
              ) : (
                <button type="button" className="ms-btn" onClick={reviewLicense}>
                  {t("reviewLicense")}
                </button>
              )}
            </div>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className={styles.fields} disabled={busy}>
              {step === 0 ? (
                <>
                  <div className={styles.addressFields}>
                    <label>
                      {t("localPart")}
                      <input
                        className="ms-input"
                        autoFocus
                        autoCapitalize="none"
                        autoComplete="off"
                        aria-required="true"
                        maxLength={64}
                        value={local}
                        placeholder={t("exampleLocal")}
                        onChange={(event) => {
                          setLocal(event.target.value);
                          setError(null);
                        }}
                      />
                    </label>
                    <span aria-hidden="true">@</span>
                    <label>
                      {t("domain")}
                      <select
                        className="ms-input"
                        aria-required="true"
                        value={domainId}
                        onChange={(event) => {
                          setDomainId(event.target.value);
                          setError(null);
                        }}
                      >
                        {options.domains.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name} ·{" "}
                            {t(entry.status === "verified" ? "verifiedShort" : "pendingShort")}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className={styles.addressPreview} aria-live="polite">
                    <span>{t("previewLabel")}</span>
                    <strong className={styles.address}>{address}</strong>
                  </div>
                  <p className={styles.hint}>{t("newAddressHint")}</p>
                  <label>
                    {t("displayName")}
                    <input
                      className="ms-input"
                      maxLength={80}
                      value={label}
                      placeholder={t("displayNameExample")}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                    <small>{t("displayNameHint")}</small>
                  </label>
                </>
              ) : step === 1 ? (
                <>
                  <p className={styles.address}>{address}</p>
                  <fieldset className={styles.kind}>
                    <legend className={styles.groupLegend}>{t("kindLabel")}</legend>
                    {(["person", "agent"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={kind === value}
                        onClick={() => setKind(value)}
                      >
                        <strong>{t(`${value}Title`)}</strong>
                        <span>{t(`${value}Body`)}</span>
                      </button>
                    ))}
                  </fieldset>
                  <p className={styles.hint}>{t("kindHint")}</p>
                  <label>
                    {t("owner")}
                    <select
                      className="ms-input"
                      aria-required="true"
                      value={ownerId}
                      onChange={(event) => {
                        setOwnerId(event.target.value);
                        setError(null);
                      }}
                    >
                      <option value="">{t("chooseOwner")}</option>
                      {options.members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name} · {member.email}
                        </option>
                      ))}
                    </select>
                    <small>{t("ownerHint")}</small>
                  </label>
                </>
              ) : (
                <>
                  <div className={styles.addressPreview}>
                    <span>{t("reviewAddress")}</span>
                    <strong className={styles.address}>{address}</strong>
                  </div>
                  <dl className={styles.summary}>
                    <div>
                      <dt>{t("kindLabel")}</dt>
                      <dd>{t(`${kind}Title`)}</dd>
                    </div>
                    <div>
                      <dt>{t("owner")}</dt>
                      <dd>{owner?.name ?? t("chooseOwner")}</dd>
                    </div>
                  </dl>
                  <ul className={styles.checks}>
                    <li>
                      <span
                        className={styles.marker}
                        data-ready={seatState === "ready"}
                        aria-hidden="true"
                      />
                      <div>
                        <strong>
                          {t(systemUnlimited ? "systemLicenseTitle" : "licenseTitle")}
                        </strong>
                        <p>
                          {t(
                            systemUnlimited
                              ? "systemLicenseReady"
                              : seatState === "ready"
                                ? "licenseReady"
                                : "licenseRequired",
                          )}
                        </p>
                        {systemUnlimited ? (
                          <button
                            type="button"
                            className="ms-btn ms-btn-ghost"
                            onClick={reviewLicense}
                          >
                            {t("reviewLicense")}
                          </button>
                        ) : null}
                      </div>
                    </li>
                    <li>
                      <span
                        className={styles.marker}
                        data-ready={domain?.status === "verified"}
                        aria-hidden="true"
                      />
                      <div>
                        <strong>{t("sendingTitle")}</strong>
                        <p>
                          {t(domain?.status === "verified" ? "sendingVerified" : "sendingPending")}
                        </p>
                      </div>
                    </li>
                    <li>
                      <span className={styles.marker} aria-hidden="true" />
                      <div>
                        <strong>{t("receivingTitle")}</strong>
                        <p>{t("receivingBody")}</p>
                      </div>
                    </li>
                  </ul>
                  <p className={styles.reservation}>{t("reservationBody")}</p>
                </>
              )}
            </fieldset>
            {error ? (
              <p role="alert" className={styles.error}>
                {t(`errors.${error}`)}
              </p>
            ) : null}
            <footer className={styles.footer}>
              <button
                type="button"
                className="ms-btn"
                disabled={busy}
                onClick={() => {
                  if (step === 0) close();
                  else {
                    setStep((current) => current - 1);
                    setError(null);
                  }
                }}
              >
                {t(step === 0 ? "cancel" : "back")}
              </button>
              <button
                type="submit"
                className="ms-btn ms-btn-primary"
                disabled={busy || !options.domains.length || (step === 2 && seatState !== "ready")}
              >
                {t(busy ? "saving" : step === 2 ? "reserve" : "continue")}
              </button>
            </footer>
          </form>
        </>
      )}
    </dialog>
  );
}
