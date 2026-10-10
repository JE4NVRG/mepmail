import { describe, expect, it } from "vitest";
import {
  mailboxTimeAllowed,
  mailboxTimeLabel,
  mailboxTimePresets,
  parseLocalDateTime,
  toLocalDateTime,
} from "./mailbox-time";

// Local times: Wednesday 15 Oct 2026.
const wednesday = (h: number, m = 0) => new Date(2026, 9, 14, h, m);
const keys = (presets: { key: string }[]) => presets.map((p) => p.key);
const local = (d: Date) => toLocalDateTime(d);

describe("mailboxTimePresets", () => {
  it("offers later today, tomorrow, the weekend and next week for a snooze", () => {
    const presets = mailboxTimePresets("snooze", wednesday(10, 20));
    expect(keys(presets)).toEqual(["laterToday", "tomorrowMorning", "weekend", "nextWeek"]);
    expect(local(presets[0]!.at)).toBe("2026-10-14T14:00");
    expect(local(presets[1]!.at)).toBe("2026-10-15T08:00");
    expect(local(presets[2]!.at)).toBe("2026-10-17T09:00");
    expect(local(presets[3]!.at)).toBe("2026-10-19T08:00");
  });

  it("drops later today late in the day and the weekend on a weekend", () => {
    expect(keys(mailboxTimePresets("snooze", wednesday(20)))).toEqual([
      "tomorrowMorning",
      "weekend",
      "nextWeek",
    ]);
    const saturday = new Date(2026, 9, 17, 10);
    expect(keys(mailboxTimePresets("snooze", saturday))).toEqual([
      "laterToday",
      "tomorrowMorning",
      "nextWeek",
    ]);
  });

  it("keeps whole hours for later today", () => {
    expect(local(mailboxTimePresets("snooze", wednesday(9))[0]!.at)).toBe("2026-10-14T12:00");
  });

  it("offers sending tomorrow morning or afternoon, or next Monday", () => {
    const presets = mailboxTimePresets("sendLater", wednesday(16));
    expect(keys(presets)).toEqual(["tomorrowMorning", "tomorrowAfternoon", "nextWeek"]);
    expect(local(presets[2]!.at)).toBe("2026-10-19T08:00");
  });

  it("follows up after one day, three days or a week at the same time", () => {
    const presets = mailboxTimePresets("followUp", wednesday(16, 30));
    expect(presets.map((p) => local(p.at))).toEqual([
      "2026-10-15T16:30",
      "2026-10-17T16:30",
      "2026-10-21T16:30",
    ]);
  });
});

describe("times the server takes", () => {
  it("accepts a minute to a year ahead", () => {
    const now = wednesday(10);
    expect(mailboxTimeAllowed(new Date(now.getTime() + 30_000), now)).toBe(false);
    expect(mailboxTimeAllowed(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(mailboxTimeAllowed(new Date(now.getTime() + 367 * 86_400_000), now)).toBe(false);
  });

  it("reads and writes datetime-local values in local time", () => {
    const date = parseLocalDateTime("2026-10-20T08:15");
    expect(date && local(date)).toBe("2026-10-20T08:15");
    expect(parseLocalDateTime("2026-02-30T08:00")).toBeNull();
    expect(parseLocalDateTime("tomorrow")).toBeNull();
  });
});

describe("mailboxTimeLabel", () => {
  it("names tomorrow, weekdays and dates with the time", () => {
    const now = wednesday(10);
    expect(mailboxTimeLabel(new Date(2026, 9, 15, 8), now, "pt-BR")).toBe("amanhã, 08:00");
    expect(mailboxTimeLabel(new Date(2026, 9, 14, 18), now, "en")).toBe("today, 06:00 PM");
    expect(mailboxTimeLabel(new Date(2026, 9, 17, 9), now, "pt-BR")).toMatch(/^sáb\.?, 09:00$/);
    expect(mailboxTimeLabel(new Date(2026, 10, 2, 8), now, "pt-BR")).toMatch(/2 de nov\.?, 08:00/);
  });
});
