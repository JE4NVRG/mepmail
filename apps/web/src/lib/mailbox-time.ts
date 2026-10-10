/**
 * Suggested times for snoozing a message, sending a draft later and following
 * up on a sent one, the way Spark offers them: a few named moments in local
 * time plus "pick a date and time". The server takes any time from one minute
 * to one year ahead.
 */

export type MailboxTimeKind = "snooze" | "sendLater" | "followUp";
export type MailboxTimePreset = {
  key:
    | "laterToday"
    | "tonight"
    | "tomorrowMorning"
    | "tomorrowAfternoon"
    | "weekend"
    | "nextWeek"
    | "inOneDay"
    | "inThreeDays"
    | "inOneWeek";
  at: Date;
};

const MINUTE = 60_000;
export const MAILBOX_TIME_MIN_MS = MINUTE;
export const MAILBOX_TIME_MAX_MS = 366 * 24 * 60 * MINUTE;

function at(base: Date, days: number, hours: number, minutes = 0) {
  const date = new Date(base);
  date.setDate(date.getDate() + days);
  date.setHours(hours, minutes, 0, 0);
  return date;
}
/** Days until the next given weekday (0 = Sunday), never today. */
function daysUntil(now: Date, weekday: number) {
  const ahead = (weekday - now.getDay() + 7) % 7;
  return ahead === 0 ? 7 : ahead;
}

/** The named moments for each kind, in local time, earliest first, all in the future. */
export function mailboxTimePresets(kind: MailboxTimeKind, now: Date): MailboxTimePreset[] {
  const presets: MailboxTimePreset[] = [];
  if (kind === "snooze") {
    // "Later today": three hours on, rounded up to the hour, while the day lasts.
    const later = new Date(now.getTime() + 3 * 60 * MINUTE);
    if (later.getMinutes() || later.getSeconds() || later.getMilliseconds()) {
      later.setMinutes(0, 0, 0);
      later.setHours(later.getHours() + 1);
    }
    if (later.getDate() === now.getDate() && later.getHours() <= 21)
      presets.push({ key: "laterToday", at: later });
    else if (now.getHours() < 18) presets.push({ key: "tonight", at: at(now, 0, 19) });
    presets.push({ key: "tomorrowMorning", at: at(now, 1, 8) });
    // Saturday morning, unless today already is the weekend.
    if (now.getDay() !== 6 && now.getDay() !== 0)
      presets.push({ key: "weekend", at: at(now, daysUntil(now, 6), 9) });
    presets.push({ key: "nextWeek", at: at(now, daysUntil(now, 1), 8) });
  } else if (kind === "sendLater") {
    presets.push({ key: "tomorrowMorning", at: at(now, 1, 8) });
    presets.push({ key: "tomorrowAfternoon", at: at(now, 1, 13) });
    presets.push({ key: "nextWeek", at: at(now, daysUntil(now, 1), 8) });
  } else {
    presets.push({ key: "inOneDay", at: at(now, 1, now.getHours(), now.getMinutes()) });
    presets.push({ key: "inThreeDays", at: at(now, 3, now.getHours(), now.getMinutes()) });
    presets.push({ key: "inOneWeek", at: at(now, 7, now.getHours(), now.getMinutes()) });
  }
  const seen = new Set<number>();
  return presets
    .filter((preset) => mailboxTimeAllowed(preset.at, now))
    .filter((preset) => !seen.has(preset.at.getTime()) && seen.add(preset.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Whether the server would take this time. */
export function mailboxTimeAllowed(value: Date, now: Date): boolean {
  const ahead = value.getTime() - now.getTime();
  return Number.isFinite(ahead) && ahead >= MAILBOX_TIME_MIN_MS && ahead <= MAILBOX_TIME_MAX_MS;
}

/** A datetime-local value ("2026-10-10T08:00") as a local Date, or null. */
export function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
    ? date
    : null;
}

/** A local Date as a datetime-local value. */
export function toLocalDateTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** "amanhã, 08:00" / "sáb., 09:00" / "12 de out., 08:00": short, local, with the time. */
export function mailboxTimeLabel(value: Date, now: Date, locale: string): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(value) - day(now)) / (24 * 60 * MINUTE));
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
    value,
  );
  if (days === 0 || days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day");
    return `${word}, ${time}`;
  }
  if (days > 1 && days < 7)
    return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(value)}, ${time}`;
  const options: Intl.DateTimeFormatOptions =
    value.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" };
  return `${new Intl.DateTimeFormat(locale, options).format(value)}, ${time}`;
}
