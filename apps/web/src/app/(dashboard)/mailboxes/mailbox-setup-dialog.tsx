"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { DOCS_URL } from "@/lib/docs-links";
import {
  formatMailboxPrice,
  formatMailboxStorage,
  mailboxHasUnlimitedSeats,
  mailboxOfferSelection,
  mailboxSetupFailure,
  mailboxSetupLocalPart,
  mailboxSetupReceiving,
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
  reviewLicense: (offerId?: string) => void;
}) {
  const t = useTranslations("mailboxes.setup");
  const mailboxT = useTranslations("mailboxes");
  const planT = useTranslations("mailboxes-service");
  const locale = useLocale();
  const trpc = useTRPC();
  const queries = useQueryClient();
  const service = useQuery(trpc.mailboxes.service.queryOptions(undefined, { retry: false }));
  const create = useMutation(trpc.mailboxes.create.mutationOptions());
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const offerSelectId = useId();
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
    | ReturnType<typeof mailboxSetupFailure>
    | "domainInvalid"
    | "addressInvalid"
    | "ownerInvalid"
    | null
  >(null);
  const [saved, setSaved] = useState<{ id: string; address: string } | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const domain = options.domains.find((entry) => entry.id === domainId);
  const receivingQuery = useQuery(
    trpc.mailboxes.receiving.queryOptions(
      { domainId },
      { enabled: !!domainId, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
    ),
  );
  const receiving = mailboxSetupReceiving(
    receivingQuery.isPending || receivingQuery.isFetching || receivingQuery.isError
      ? undefined
      : receivingQuery.data,
  );
  const systemIdentified = service.data?.licenseKind === "system";
  const billing = useQuery(
    trpc.mailboxes.billing.queryOptions(undefined, {
      enabled: step === 1 && !systemIdentified && !service.isPending && !service.isError,
      retry: false,
      refetchOnWindowFocus: false,
    }),
  );
  const selection = mailboxOfferSelection(
    !systemIdentified && !billing.isPending && !billing.isFetching && !billing.isError
      ? billing.data
      : undefined,
    selectedOfferId,
  );
  const canChoosePlan =
    !systemIdentified &&
    !service.isPending &&
    !service.isError &&
    billing.data?.canPurchase === true &&
    !!selection.offer &&
    (selection.offers.length > 0 || selection.locked);
  const owner = options.members.find((member) => member.id === ownerId);
  const normalized = mailboxSetupLocalPart(local);
  const address = `${normalized ?? (local.trim() || t("exampleLocal"))}@${domain?.name ?? t("exampleDomain")}`;
  const seatState = mailboxSetupSeatState(service.data, service.isPending, service.isError);
  const systemUnlimited = seatState === "ready" && mailboxHasUnlimitedSeats(service.data);
  const busy = create.isPending;

  function openLicense() {
    reviewLicense(canChoosePlan ? (selection.offerId ?? undefined) : undefined);
  }

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Announce each wizard step and the confirmed reservation by moving focus to its heading.
  useEffect(() => {
    heading.current?.focus();
  }, [step, saved]);

  function advance() {
    if (!domain) {
      setError("domainInvalid");
      return;
    }
    if (step >= 2 && !normalized) {
      setError("addressInvalid");
      return;
    }
    if (step >= 2 && !owner) {
      setError("ownerInvalid");
      return;
    }
    setError(null);
    setStep((current) => Math.min(3, current + 1));
  }

  async function submit() {
    if (busy || saved) return;
    if (step < 3) {
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

  function domainReadiness() {
    return (
      <ul className={styles.checks}>
        <li>
          <span
            className={styles.marker}
            data-ready={domain?.status === "verified"}
            aria-hidden="true"
          />
          <div>
            <strong>{t("sendingTitle")}</strong>
            <p>{t(domain?.status === "verified" ? "sendingVerified" : "sendingPending")}</p>
          </div>
        </li>
        <li>
          <span
            className={styles.marker}
            data-ready={receiving.state === "ready"}
            aria-hidden="true"
          />
          <div>
            <strong>{t("receivingTitle")}</strong>
            <p
              role={
                receivingQuery.isError ? "alert" : receivingQuery.isFetching ? "status" : undefined
              }
            >
              {t(
                receivingQuery.isError
                  ? "receivingError"
                  : receivingQuery.isPending || receivingQuery.isFetching
                    ? "receivingChecking"
                    : `receiving.${receiving.state}`,
              )}
            </p>
            {receiving.state === "needs_mx" && receiving.mxHost ? (
              <p>
                {t("mxDestination")} <code className={styles.mxHost}>{receiving.mxHost}</code>
              </p>
            ) : null}
          </div>
        </li>
      </ul>
    );
  }

  function licenseNotice() {
    if (seatState === "ready") return null;
    return (
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
          <button type="button" className="ms-btn" onClick={openLicense}>
            {t("reviewLicense")}
          </button>
        )}
      </div>
    );
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
          {domainReadiness()}
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
            {(["domainStep", "licenseStep", "addressStep", "reviewStep"] as const).map(
              (name, index) => (
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
              ),
            )}
          </ol>
          {step === 1 || step === 3 ? licenseNotice() : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className={styles.fields} disabled={busy}>
              {step === 0 ? (
                <>
                  {options.domains.length ? (
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
                            {entry.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <div className={styles.notice}>
                      <div>
                        <strong>{t("noDomainsTitle")}</strong>
                        <p>{t("noDomainsBody")}</p>
                      </div>
                      <Link className="ms-btn" href="/domains/new">
                        {t("addDomain")}
                      </Link>
                    </div>
                  )}
                  <p className={styles.hint}>{t("domainBody")}</p>
                  {domain ? domainReadiness() : null}
                  <p className={styles.reservation}>{t("existingProviderBody")}</p>
                  {domain ? (
                    <div className={styles.successActions}>
                      <button
                        type="button"
                        className="ms-btn ms-btn-ghost"
                        disabled={receivingQuery.isFetching}
                        onClick={() => void receivingQuery.refetch()}
                      >
                        {t("checkReceiving")}
                      </button>
                      <Link className="ms-btn ms-btn-ghost" href={`/domains/${domain.id}`}>
                        {t("viewDomain")}
                      </Link>
                      <Link className="ms-btn ms-btn-ghost" href="/domains/new">
                        {t("addDomain")}
                      </Link>
                      <Link className="ms-btn ms-btn-ghost" href="/domains">
                        {mailboxT("domainsLink")}
                      </Link>
                    </div>
                  ) : null}
                </>
              ) : step === 1 ? (
                <>
                  <div className={styles.addressPreview}>
                    <strong>{t(systemUnlimited ? "systemLicenseTitle" : "licenseTitle")}</strong>
                    <p className={styles.hint}>
                      {t(
                        systemUnlimited
                          ? "systemLicenseReady"
                          : seatState === "ready"
                            ? "licenseReady"
                            : "licenseRequired",
                      )}
                    </p>
                  </div>
                  {!service.isPending &&
                  !service.isError &&
                  service.data &&
                  service.data.licenseKind !== "none" ? (
                    <>
                      <dl className={styles.summary}>
                        <div>
                          <dt>{t("licenseMailboxes")}</dt>
                          <dd>
                            {t(systemUnlimited ? "licenseUnlimited" : "licenseSeats", {
                              used: service.data.reservedSeats,
                              total: service.data.seats,
                            })}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("storagePerMailbox")}</dt>
                          <dd>
                            {formatMailboxStorage(service.data.storageBytesPerMailbox, locale)}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("outboundPerMailbox")}</dt>
                          <dd>
                            {systemUnlimited && service.data.unlimitedOutbound
                              ? t("systemUnlimitedOutbound")
                              : t("outboundCount", {
                                  count: service.data.includedOutboundPerMailbox,
                                })}
                          </dd>
                        </div>
                      </dl>
                      <p className={styles.hint}>
                        {t(
                          systemUnlimited && service.data.unlimitedOutbound
                            ? "systemResourceLimitsBody"
                            : "resourceLimitsBody",
                        )}
                      </p>
                      {!service.data.resourcePolicyActive ? (
                        <p className={styles.reservation}>{t("resourcePolicyPending")}</p>
                      ) : null}
                    </>
                  ) : null}
                  {canChoosePlan && selection.offer ? (
                    <>
                      <label htmlFor={offerSelectId}>
                        {planT("planChoice")}
                        <select
                          id={offerSelectId}
                          className="ms-input"
                          value={selection.offerId ?? ""}
                          disabled={selection.locked}
                          onChange={(event) => setSelectedOfferId(event.target.value)}
                        >
                          {(selection.locked && selection.offerId
                            ? [{ ...selection.offer, offerId: selection.offerId }]
                            : selection.offers
                          ).map((entry) => (
                            <option key={entry.offerId} value={entry.offerId}>
                              {planT("planOption", {
                                storage: formatMailboxStorage(entry.storageBytesPerMailbox, locale),
                                price: planT("priceInterval", {
                                  amount: formatMailboxPrice(
                                    entry.unitAmount,
                                    entry.currency,
                                    locale,
                                  ),
                                  interval: planT(`interval.${entry.interval}`),
                                }),
                              })}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className={styles.hint}>
                        {planT(selection.locked ? "planLocked" : "planChoiceHint")}
                      </p>
                      <div className={styles.addressPreview}>
                        <strong>
                          {planT("priceInterval", {
                            amount: formatMailboxPrice(
                              selection.offer.unitAmount,
                              selection.offer.currency,
                              locale,
                            ),
                            interval: planT(`interval.${selection.offer.interval}`),
                          })}
                        </strong>
                        <p className={styles.hint}>
                          {planT("selectedPlanAllowance", {
                            storage: formatMailboxStorage(
                              selection.offer.storageBytesPerMailbox,
                              locale,
                            ),
                            messages: selection.offer.includedOutboundPerMailbox,
                          })}
                        </p>
                      </div>
                      <button type="button" className="ms-btn" onClick={openLicense}>
                        {planT(selection.locked ? "retryCheckout" : "reviewSelectedPlan")}
                      </button>
                    </>
                  ) : !systemIdentified && billing.isError ? (
                    <div className={styles.notice} role="alert">
                      <div>
                        <p>{planT("loadError")}</p>
                      </div>
                      <button
                        type="button"
                        className="ms-btn"
                        onClick={() => void billing.refetch()}
                      >
                        {t("retry")}
                      </button>
                    </div>
                  ) : null}
                  {seatState === "ready" && !canChoosePlan ? (
                    <button type="button" className="ms-btn ms-btn-ghost" onClick={openLicense}>
                      {t("reviewLicense")}
                    </button>
                  ) : null}
                </>
              ) : step === 2 ? (
                <>
                  <div className={styles.addressFields}>
                    <label>
                      {t("localPart")}
                      <input
                        className="ms-input"
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
                    <span className={styles.domainSuffix}>@{domain?.name}</span>
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
                            onClick={openLicense}
                          >
                            {t("reviewLicense")}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  </ul>
                  {domainReadiness()}
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
                disabled={busy || !options.domains.length || (step === 3 && seatState !== "ready")}
              >
                {t(busy ? "saving" : step === 3 ? "reserve" : "continue")}
              </button>
            </footer>
          </form>
        </>
      )}
    </dialog>
  );
}
