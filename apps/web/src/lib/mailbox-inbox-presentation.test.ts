import { describe, expect, it } from "vitest";
import {
  createMailboxListDateFormatter,
  mailboxFolderOrderAfterMove,
  mailboxFolderTint,
  mailboxListDate,
} from "./mailbox-inbox-presentation";

describe("mailbox list dates", () => {
  const at = (year: number, month: number, day: number, hour = 9, minute = 5) =>
    new Date(year, month, day, hour, minute);

  it("advances the same formatter from today's time to yesterday after midnight", () => {
    const format = createMailboxListDateFormatter("pt-BR");
    const message = at(2026, 9, 16);
    expect(format(message, at(2026, 9, 16, 23, 59))).toBe("09:05");
    expect(format(message, at(2026, 9, 17, 0, 1))).toBe("Ontem");
    expect(format(message, at(2026, 9, 16, 23, 59))).toBe("09:05");
  });

  it("keeps weekday, month and prior-year labels across repeated renders", () => {
    const format = createMailboxListDateFormatter("pt-BR");
    const now = at(2026, 9, 16);
    for (let render = 0; render < 3; render++) {
      expect(format(at(2026, 9, 14), now)).toBe("qua.");
      expect(format(at(2026, 9, 9), now)).toBe("9 de out.");
      expect(format(at(2025, 9, 16), now)).toBe("16/10/2025");
    }
  });

  it("keeps locale instances independent and the existing single-date API", () => {
    const now = at(2026, 9, 16);
    const message = at(2026, 9, 15);
    const portuguese = createMailboxListDateFormatter("pt-BR");
    const english = createMailboxListDateFormatter("en-US");
    expect(portuguese(message, now)).toBe("Ontem");
    expect(english(message, now)).toBe("Yesterday");
    expect(portuguese(message, now)).toBe("Ontem");
    expect(mailboxListDate(message, now, "en-US")).toBe("Yesterday");
  });

  it("uses calendar days at the change of year", () => {
    const format = createMailboxListDateFormatter("pt-BR");
    expect(format(at(2026, 11, 31, 23, 55), at(2027, 0, 1, 0, 5))).toBe("Ontem");
  });
});

describe("mailboxFolderTint", () => {
  it("accepts the server's named colors and nothing else", () => {
    expect(mailboxFolderTint("violet")).toBe("violet");
    expect(mailboxFolderTint("teal")).toBe("teal");
    expect(mailboxFolderTint(null)).toBeNull();
    expect(mailboxFolderTint(undefined)).toBeNull();
    expect(mailboxFolderTint("#ff0000")).toBeNull();
    expect(mailboxFolderTint("VIOLET")).toBeNull();
  });
});

describe("mailboxFolderOrderAfterMove", () => {
  const ids = ["a", "b", "c"];

  it("swaps a folder with its neighbour", () => {
    expect(mailboxFolderOrderAfterMove(ids, "b", "up")).toEqual(["b", "a", "c"]);
    expect(mailboxFolderOrderAfterMove(ids, "b", "down")).toEqual(["a", "c", "b"]);
    expect(mailboxFolderOrderAfterMove(ids, "c", "up")).toEqual(["a", "c", "b"]);
  });

  it("returns the same list when the move is impossible", () => {
    expect(mailboxFolderOrderAfterMove(ids, "a", "up")).toBe(ids);
    expect(mailboxFolderOrderAfterMove(ids, "c", "down")).toBe(ids);
    expect(mailboxFolderOrderAfterMove(ids, "zzz", "down")).toBe(ids);
  });
});
