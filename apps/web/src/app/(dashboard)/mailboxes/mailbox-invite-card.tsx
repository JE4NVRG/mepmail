"use client";

import { useLocale, useTranslations } from "next-intl";
import { googleCalendarLink, type MailboxInvite, type MailboxInviteTime } from "@/lib/mailbox-ics";
import styles from "./mailbox-invite-card.module.css";

function when(invite: MailboxInvite, locale: string): { primary: string; zone: string | null } {
  const dateOnly = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00Z`),
    );
  if (invite.allDay) return { primary: dateOnly(invite.start.local), zone: null };
  const moment = (time: MailboxInviteTime) =>
    time.utc ? new Date(time.utc) : new Date(`${time.local}:00Z`);
  // A known instant shows in this device's time; otherwise the sender's wall clock and zone.
  const known = !!invite.start.utc;
  const zone = known ? undefined : "UTC";
  const start = moment(invite.start);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: zone }).format(start);
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: zone });
  const range = invite.end
    ? `${clock.format(start)} – ${clock.format(moment(invite.end))}`
    : clock.format(start);
  return { primary: `${day}, ${range}`, zone: known ? null : invite.start.zone };
}

/**
 * Convites de calendário: the event a message carries (title, time, place,
 * organizer), with the meeting link, "Google Agenda" and the .ics itself.
 */
export function MailboxInviteCard({
  invite,
  downloadHref,
}: {
  invite: MailboxInvite;
  downloadHref?: string | undefined;
}) {
  const t = useTranslations("mailboxes.invite");
  const locale = useLocale();
  const time = when(invite, locale);
  const google = invite.cancelled ? null : googleCalendarLink(invite);
  const badge = invite.cancelled
    ? "cancelled"
    : invite.method === "REPLY"
      ? "reply"
      : invite.method === "REQUEST"
        ? "request"
        : "event";
  return (
    <section className={styles.card} aria-label={t("label")} data-cancelled={invite.cancelled}>
      <span className={styles.badge} data-kind={badge}>
        {t(`badge.${badge}`)}
      </span>
      <h3 className={styles.title}>{invite.summary || t("untitled")}</h3>
      <dl className={styles.details}>
        <dt>{t("when")}</dt>
        <dd>
          {time.primary}
          {time.zone ? <span className={styles.zone}> ({time.zone})</span> : null}
        </dd>
        {invite.location ? (
          <>
            <dt>{t("where")}</dt>
            <dd>{invite.location}</dd>
          </>
        ) : null}
        {invite.organizer ? (
          <>
            <dt>{t("organizer")}</dt>
            <dd>
              {invite.organizer.name
                ? `${invite.organizer.name} <${invite.organizer.address}>`
                : invite.organizer.address}
            </dd>
          </>
        ) : null}
        {invite.attendees > 1 ? (
          <>
            <dt>{t("guests")}</dt>
            <dd>{t("guestCount", { count: invite.attendees })}</dd>
          </>
        ) : null}
      </dl>
      {!invite.cancelled && (invite.conference || google || downloadHref) ? (
        <div className={styles.actions}>
          {invite.conference ? (
            <a
              className="ms-btn ms-btn-primary"
              href={invite.conference}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("join")}
            </a>
          ) : null}
          {google ? (
            <a className="ms-btn" href={google} target="_blank" rel="noopener noreferrer">
              {t("google")}
            </a>
          ) : null}
          {downloadHref ? (
            <a className="ms-btn ms-btn-ghost" href={downloadHref}>
              {t("download")}
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
