import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canChooseNativePlainText,
  nativeDraftIsReadOnly,
  nativePlainTextSaveFields,
} from "../src/lib/mailbox-native-compose";

const fresh = { source: null, html: null, uploads: 0, retained: 0 };
describe("Native composition representation boundary", () => {
  it("opts in only on a complete new text-only message", () => {
    expect(canChooseNativePlainText(fresh)).toBe(true);
    expect(nativePlainTextSaveFields(fresh)).toEqual({ messageFormat: "plain_text" });
  });
  it.each([
    { source: { kind: "draft", revision: 1 } },
    { html: "<p>Logo</p>" },
    { uploads: 1 },
    { retained: 1 },
  ])("refuses incompatible composition without deleting it: %j", (extra) => {
    expect(() => nativePlainTextSaveFields({ ...fresh, ...extra })).toThrow();
  });
  it.each(["plain_text", "unknown", undefined, "future"])(
    "never opens %s saved MIME for rewriting",
    (draftMessageFormat) => {
      expect(nativeDraftIsReadOnly({ kind: "draft", draftMessageFormat })).toBe(true);
    },
  );
  it("preserves explicitly classified formatted legacy editing", () => {
    expect(nativeDraftIsReadOnly({ kind: "draft", draftMessageFormat: "formatted" })).toBe(false);
    expect(nativeDraftIsReadOnly({ kind: "inbox" })).toBe(false);
  });
  it("wires manual review, no retries, exact revision and queued-only states in the real caller", () => {
    const ui = readFileSync(
      new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
      "utf8",
    );
    expect(ui).toMatch(/nativePlainTextSaveFields\(\{\s*source,\s*html: richHtml/);
    expect(ui).toContain("saveDraft.mutationOptions({ retry: false })");
    expect(ui).toMatch(/!plainText\s*&&\s*canSend\s*&&/);
    expect(ui).toContain("canSend && !plainText && !plainSaveUncertain");
    expect(ui).toContain("expectedRevision: item.revision");
    expect(ui).toContain("expectedRevision: saved.revision");
    expect(ui).toContain("if (source && nativeDraftIsReadOnly(source))");
    expect(ui).toMatch(
      /sendMutation\s*=\s*useMutation\(\s*trpc\.mailboxes\.queueDraft\.mutationOptions\(\{ retry: false \}\),?\s*\)/,
    );
  });
});
