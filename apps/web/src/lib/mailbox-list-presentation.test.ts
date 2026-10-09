import { describe, expect, it } from "vitest";
import { mailboxAvatarHue, mailboxDateSection, mailboxInitials } from "./mailbox-list-presentation";

describe("mailboxDateSection", () => {
  const now = new Date(2026, 9, 15, 14, 30); // 15 Oct 2026, local time
  const at = (year: number, month: number, day: number, hour = 9) =>
    new Date(year, month, day, hour);

  it("names today, yesterday and the last week by calendar day, not by 24 h spans", () => {
    expect(mailboxDateSection(at(2026, 9, 15, 0), now)).toBe("today");
    expect(mailboxDateSection(at(2026, 9, 14, 23), now)).toBe("yesterday");
    expect(mailboxDateSection(at(2026, 9, 13), now)).toBe("week");
    expect(mailboxDateSection(at(2026, 9, 9), now)).toBe("week");
    expect(mailboxDateSection(at(2026, 9, 8), now)).toBe("month");
  });

  it("keeps the rest of the calendar month together and everything else as older", () => {
    expect(mailboxDateSection(at(2026, 9, 1), now)).toBe("month");
    expect(mailboxDateSection(at(2026, 8, 30), now)).toBe("older");
    expect(mailboxDateSection(at(2025, 9, 15), now)).toBe("older");
  });

  it("treats a future date as today", () => {
    expect(mailboxDateSection(at(2026, 9, 20), now)).toBe("today");
  });
});

describe("mailboxInitials", () => {
  it("takes the first and last words of a name", () => {
    expect(mailboxInitials("Maya Chen", "maya@example.com")).toBe("MC");
    expect(mailboxInitials("Ana Lúcia de Souza", "ana@example.com")).toBe("AS");
    expect(mailboxInitials("priya", "p@example.com")).toBe("P");
  });

  it("ignores quotes and punctuation and falls back to the address", () => {
    expect(mailboxInitials('"Northwind" <billing>', "x@example.com")).toBe("NB");
    expect(mailboxInitials("", "support@mepmail.dev")).toBe("S");
    expect(mailboxInitials(null, "_7days@example.com")).toBe("7");
    expect(mailboxInitials(undefined, "")).toBe("?");
  });
});

describe("mailboxAvatarHue", () => {
  it("is stable, case-insensitive and within 0..359", () => {
    const hue = mailboxAvatarHue("Maya@Example.com");
    expect(hue).toBe(mailboxAvatarHue(" maya@example.com "));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
    expect(mailboxAvatarHue("a@example.com")).not.toBe(mailboxAvatarHue("b@example.com"));
    expect(mailboxAvatarHue(null)).toBe(mailboxAvatarHue(""));
  });
});
