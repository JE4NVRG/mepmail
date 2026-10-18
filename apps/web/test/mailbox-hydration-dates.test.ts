import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Correio list and reader print dates in the reader's zone, which the server (UTC) cannot
 * know. Formatted during hydration they did not match the server HTML: React error #418 on
 * phones, a client re-render of the whole page, and <html>'s attributes cleared with it (the
 * Android app mark). Both helpers wait for the client render.
 */
const view = readFileSync(
  new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
  "utf8",
);

describe("Correio dates and hydration", () => {
  it("formats dates only after the first client render", () => {
    expect(view.replace(/\s+/g, " ")).toContain(
      "const clientClock = useSyncExternalStore( noClockChange, () => true, () => false, );",
    );
    expect(view).toContain(
      'const listDate = (value: Date) => (clientClock ? dateFormats.list(value, now) : "");',
    );
    expect(view).toContain(
      'const date = (value: Date) => (clientClock ? dateFormats.full.format(value) : "");',
    );
  });
});
