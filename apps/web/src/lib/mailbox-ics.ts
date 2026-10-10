/**
 * Convites de calendário: the first event of an iCalendar (RFC 5545) part,
 * reduced to what an invite card shows. Tolerant and bounded: unknown
 * properties are ignored, text is cut, and anything that does not look like a
 * calendar returns null. Times keep the sender's wall clock and zone; `utc`
 * is filled when the moment is known (a Z time, or an IANA zone this runtime
 * knows).
 */
export type MailboxInviteTime = {
  /** The instant, when it can be known. */
  utc: string | null;
  /** Wall clock as written: YYYY-MM-DD or YYYY-MM-DDTHH:MM. */
  local: string;
  /** The TZID as written, when there was one. */
  zone: string | null;
};

export type MailboxInvite = {
  method: "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH" | null;
  uid: string;
  summary: string;
  location: string;
  description: string;
  organizer: { name: string; address: string } | null;
  start: MailboxInviteTime;
  end: MailboxInviteTime | null;
  allDay: boolean;
  cancelled: boolean;
  attendees: number;
  /** A meeting link (https only). */
  conference: string | null;
};

const MAX_ICS = 256 * 1024;
const LIMITS = { summary: 300, location: 300, description: 2000, uid: 300 };
const METHODS = new Set(["REQUEST", "CANCEL", "REPLY", "PUBLISH"]);

type Property = { name: string; params: Record<string, string>; value: string };

function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

function property(line: string): Property | null {
  // NAME;PARAM=VALUE;PARAM="QUOTED:VALUE":VALUE — the first colon outside quotes ends the head.
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (character === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;
  const [rawName = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const equals = param.indexOf("=");
    if (equals > 0)
      params[param.slice(0, equals).toUpperCase()] = param.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1) };
}

const text = (value: string, max: number) =>
  Array.from(
    value
      .replace(/\\n/gi, "\n")
      .replace(/\\([,;\\])/g, "$1")
      .trim(),
  )
    .slice(0, max)
    .join("");

function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - instant;
}

/** The instant a wall-clock time in an IANA zone names, or null for a zone this runtime lacks. */
export function wallTimeToUtc(wall: number, zone: string): number | null {
  try {
    const first = wall - zoneOffsetMs(wall, zone);
    // Once more with the offset at the guessed instant (DST edges).
    return wall - zoneOffsetMs(first, zone);
  } catch {
    return null;
  }
}

function time(prop: Property): MailboxInviteTime | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const date = `${y}-${mo}-${d}`;
  if (h === undefined) return { utc: null, local: date, zone: null };
  const wall = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  if (Number.isNaN(wall)) return null;
  const zone = prop.params.TZID ?? null;
  const instant = z ? wall : zone ? wallTimeToUtc(wall, zone) : null;
  return {
    utc: instant === null ? null : new Date(instant).toISOString(),
    local: `${date}T${h}:${mi}`,
    zone: z ? "UTC" : zone,
  };
}

function httpsLink(value: string): string | null {
  const found = /https:\/\/[^\s<>"']+/i.exec(value);
  if (!found) return null;
  try {
    const url = new URL(found[0]);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseMailboxInvite(source: string): MailboxInvite | null {
  if (!source || source.length > MAX_ICS || !/BEGIN:VCALENDAR/i.test(source)) return null;
  let method: MailboxInvite["method"] = null;
  let event: Property[] | null = null;
  let depth = 0;
  for (const line of unfold(source)) {
    const prop = property(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const what = prop.value.trim().toUpperCase();
      if (what === "VEVENT" && event === null && depth === 0) {
        event = [];
        continue;
      }
      if (event) depth++;
      continue;
    }
    if (prop.name === "END") {
      const what = prop.value.trim().toUpperCase();
      if (event && depth > 0) depth--;
      else if (event && what === "VEVENT") break;
      continue;
    }
    if (event && depth === 0) event.push(prop);
    else if (!event && prop.name === "METHOD") {
      const value = prop.value.trim().toUpperCase();
      method = METHODS.has(value) ? (value as MailboxInvite["method"]) : null;
    }
  }
  if (!event) return null;
  const get = (name: string) => event?.find((prop) => prop.name === name);
  const startProp = get("DTSTART");
  const start = startProp ? time(startProp) : null;
  if (!start) return null;
  const endProp = get("DTEND");
  const end = endProp ? time(endProp) : null;
  const organizerProp = get("ORGANIZER");
  const organizerAddress = organizerProp?.value.replace(/^mailto:/i, "").trim() ?? "";
  const description = text(get("DESCRIPTION")?.value ?? "", LIMITS.description);
  const conference =
    httpsLink(get("X-GOOGLE-CONFERENCE")?.value ?? "") ??
    httpsLink(get("URL")?.value ?? "") ??
    httpsLink(description);
  return {
    method,
    uid: text(get("UID")?.value ?? "", LIMITS.uid),
    summary: text(get("SUMMARY")?.value ?? "", LIMITS.summary),
    location: text(get("LOCATION")?.value ?? "", LIMITS.location),
    description,
    organizer: organizerAddress
      ? { name: text(organizerProp?.params.CN ?? "", 200), address: organizerAddress.slice(0, 320) }
      : null,
    start,
    end,
    allDay: !start.local.includes("T"),
    cancelled:
      method === "CANCEL" || (get("STATUS")?.value.trim().toUpperCase() ?? "") === "CANCELLED",
    attendees: event.filter((prop) => prop.name === "ATTENDEE").length,
    conference,
  };
}

const compact = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * "Adicionar ao Google Agenda": a template link with the event's own details,
 * opened only when the person clicks it. Null when the moment is not known.
 */
export function googleCalendarLink(invite: MailboxInvite): string | null {
  let dates: string;
  if (invite.allDay) {
    const start = invite.start.local.replace(/-/g, "");
    const endDay = invite.end?.local.replace(/-/g, "");
    const next = new Date(`${invite.start.local}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    dates = `${start}/${endDay ?? next.toISOString().slice(0, 10).replace(/-/g, "")}`;
  } else {
    if (!invite.start.utc) return null;
    const end =
      invite.end?.utc ?? new Date(new Date(invite.start.utc).getTime() + 3_600_000).toISOString();
    dates = `${compact(invite.start.utc)}/${compact(end)}`;
  }
  const params = new URLSearchParams({ action: "TEMPLATE", text: invite.summary, dates });
  if (invite.location) params.set("location", invite.location);
  if (invite.description) params.set("details", invite.description.slice(0, 1000));
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
