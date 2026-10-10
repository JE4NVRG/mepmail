import { describe, expect, it } from "vitest";
import { googleCalendarLink, parseMailboxInvite, wallTimeToUtc } from "./mailbox-ics";

const crlf = (...lines: string[]) => `${lines.join("\r\n")}\r\n`;

const google = crlf(
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/Sao_Paulo",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:-0300",
  "TZOFFSETTO:-0300",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Sao_Paulo:20261015T140000",
  "DTEND;TZID=America/Sao_Paulo:20261015T150000",
  'ORGANIZER;CN="Priya: Atlas Labs":mailto:priya@atlaslabs.example',
  "UID:abc123@google.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=jean@m",
  " epmail.dev:mailto:jean@mepmail.dev",
  "ATTENDEE;CN=priya@atlaslabs.example:mailto:priya@atlaslabs.example",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "DESCRIPTION:Piloto do agente\\, suporte e vendas.\\nPauta: integração",
  "LOCATION:Sala 3\\; prédio B",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Piloto MepMail",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Lembrete",
  "TRIGGER:-P0DT0H10M0S",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
);

describe("calendar invites", () => {
  it("reads a Google invite: zone, folding, escapes, quoted names, nested alarm", () => {
    expect(parseMailboxInvite(google)).toEqual({
      method: "REQUEST",
      uid: "abc123@google.com",
      summary: "Piloto MepMail",
      location: "Sala 3; prédio B",
      description: "Piloto do agente, suporte e vendas.\nPauta: integração",
      organizer: { name: "Priya: Atlas Labs", address: "priya@atlaslabs.example" },
      start: {
        utc: "2026-10-15T17:00:00.000Z",
        local: "2026-10-15T14:00",
        zone: "America/Sao_Paulo",
      },
      end: {
        utc: "2026-10-15T18:00:00.000Z",
        local: "2026-10-15T15:00",
        zone: "America/Sao_Paulo",
      },
      allDay: false,
      cancelled: false,
      attendees: 2,
      conference: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("handles cancellations, all-day events, UTC times and zones it does not know", () => {
    const cancel = parseMailboxInvite(
      crlf(
        "BEGIN:VCALENDAR",
        "METHOD:CANCEL",
        "BEGIN:VEVENT",
        "UID:x",
        "DTSTART:20261020T120000Z",
        "SUMMARY:Reunião",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
    expect(cancel).toMatchObject({
      method: "CANCEL",
      cancelled: true,
      start: { utc: "2026-10-20T12:00:00.000Z", zone: "UTC" },
      end: null,
    });
    const allDay = parseMailboxInvite(
      crlf(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART;VALUE=DATE:20261102",
        "DTEND;VALUE=DATE:20261103",
        "SUMMARY:Feriado",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
    expect(allDay).toMatchObject({
      allDay: true,
      start: { utc: null, local: "2026-11-02" },
      method: null,
    });
    const outlook = parseMailboxInvite(
      crlf(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART;TZID=E. South America Standard Time:20261015T090000",
        "SUMMARY:Outlook",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
    // Kept as written: the card shows the sender's time and zone.
    expect(outlook?.start).toEqual({
      utc: null,
      local: "2026-10-15T09:00",
      zone: "E. South America Standard Time",
    });
  });

  it("refuses what is not a calendar event and keeps only https meeting links", () => {
    expect(parseMailboxInvite("hello")).toBeNull();
    expect(parseMailboxInvite(crlf("BEGIN:VCALENDAR", "END:VCALENDAR"))).toBeNull();
    expect(
      parseMailboxInvite(
        crlf("BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:sem data", "END:VEVENT", "END:VCALENDAR"),
      ),
    ).toBeNull();
    const unsafe = parseMailboxInvite(
      crlf(
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "DTSTART:20261020T120000Z",
        "URL:javascript:alert(1)",
        "DESCRIPTION:Entre em http://insecure.example/x",
        "END:VEVENT",
        "END:VCALENDAR",
      ),
    );
    expect(unsafe?.conference).toBeNull();
  });

  it("converts wall time across daylight saving changes", () => {
    // New York, 2026-11-01 09:00 is after the switch back to EST (UTC-5).
    expect(
      new Date(wallTimeToUtc(Date.UTC(2026, 10, 1, 9, 0), "America/New_York")!).toISOString(),
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(
      new Date(wallTimeToUtc(Date.UTC(2026, 6, 1, 9, 0), "America/New_York")!).toISOString(),
    ).toBe("2026-07-01T13:00:00.000Z");
    expect(wallTimeToUtc(Date.UTC(2026, 6, 1, 9, 0), "Not/AZone")).toBeNull();
  });
});

describe("google calendar link", () => {
  it("carries the event's own moment and details, or nothing when the moment is unknown", () => {
    const invite = parseMailboxInvite(google)!;
    const link = new URL(googleCalendarLink(invite)!);
    expect(link.origin + link.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(link.searchParams.get("dates")).toBe("20261015T170000Z/20261015T180000Z");
    expect(link.searchParams.get("text")).toBe("Piloto MepMail");
    expect(link.searchParams.get("location")).toBe("Sala 3; prédio B");
    const allDay = {
      ...invite,
      allDay: true,
      start: { utc: null, local: "2026-11-02", zone: null },
      end: null,
    };
    expect(new URL(googleCalendarLink(allDay)!).searchParams.get("dates")).toBe(
      "20261102/20261103",
    );
    const unknown = {
      ...invite,
      start: { utc: null, local: "2026-10-15T09:00", zone: "Windows Zone" },
    };
    expect(googleCalendarLink(unknown)).toBeNull();
  });
});
