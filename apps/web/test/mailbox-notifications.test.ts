import { describe, expect, it } from "vitest";
import { newUnreadArrivals, noticesWanted } from "@/lib/mailbox-notifications";

const row = (
  id: string,
  extra: Partial<{ kind: string; seenAt: Date | null; blocked: boolean }> = {},
) => ({
  id,
  mailboxId: "box",
  kind: "inbox",
  seenAt: null,
  blocked: false,
  ...extra,
});

describe("new mail notices", () => {
  it("never notifies for what the first listing already shows", () => {
    const first = newUnreadArrivals(null, [row("a"), row("b")]);
    expect(first.arrivals).toEqual([]);
    expect([...first.known]).toEqual(["box:a", "box:b"]);
  });

  it("notifies once for a new unread received message only", () => {
    const { known } = newUnreadArrivals(null, [row("a")]);
    const next = newUnreadArrivals(known, [
      row("n"),
      row("read", { seenAt: new Date() }),
      row("sent", { kind: "sent" }),
      row("quarantined", { blocked: true }),
      row("a"),
    ]);
    expect(next.arrivals.map((r) => r.id)).toEqual(["n"]);
    expect(newUnreadArrivals(next.known, [row("n")]).arrivals).toEqual([]);
  });

  it("remembers rows that scrolled out of the listing", () => {
    const { known } = newUnreadArrivals(null, [row("old")]);
    const later = newUnreadArrivals(known, [row("new")]);
    expect(newUnreadArrivals(later.known, [row("old"), row("new")]).arrivals).toEqual([]);
  });
});

describe("noticesWanted", () => {
  it("is opt-in in a browser and on by default in the desktop app", () => {
    expect(noticesWanted(false, null)).toBe(false);
    expect(noticesWanted(false, "on")).toBe(true);
    expect(noticesWanted(true, null)).toBe(true);
    expect(noticesWanted(true, "off")).toBe(false);
    expect(noticesWanted(true, "on")).toBe(true);
  });
});
