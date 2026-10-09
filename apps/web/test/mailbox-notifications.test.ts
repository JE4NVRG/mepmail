import { describe, expect, it } from "vitest";
import { newUnreadArrivals } from "@/lib/mailbox-notifications";

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
