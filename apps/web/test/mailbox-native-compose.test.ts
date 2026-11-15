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

describe("fresh Native editor canonical empty paragraph", () => {
  it("allows only the exact empty onCreate serialization for both choice and manual save", () => {
    const mounted = { ...fresh, html: "<p></p>" };
    expect(canChooseNativePlainText(mounted)).toBe(true);
    expect(nativePlainTextSaveFields(mounted)).toEqual({ messageFormat: "plain_text" });
  });
  it.each([
    " ",
    "\n",
    "<p> </p>",
    "<p>\n</p>",
    "<p><br></p>",
    "<p>&nbsp;</p>",
    "<p></p><p></p>",
    "<p><strong></strong></p>",
    "<p>body</p>",
    '<p><a href="https://example.invalid">link</a></p>',
    '<img src="cid:logo">',
    "<script></script>",
    "<unknown></unknown>",
  ])("never strips or normalizes other HTML: %s", (html) => {
    const input = { ...fresh, html };
    expect(canChooseNativePlainText(input)).toBe(false);
    expect(() => nativePlainTextSaveFields(input)).toThrow(
      "plain_text_requires_new_unformatted_message",
    );
    expect(input.html).toBe(html);
  });
  it.each(["formatted", "unknown", "plain_text", undefined, "future"])(
    "never converts an existing %s source even with the empty sentinel",
    (draftMessageFormat) => {
      const source = { kind: "draft", revision: 7, draftMessageFormat };
      const before = JSON.stringify(source);
      const input = { ...fresh, source, html: "<p></p>" };
      expect(canChooseNativePlainText(input)).toBe(false);
      expect(() => nativePlainTextSaveFields(input)).toThrow();
      expect(JSON.stringify(source)).toBe(before);
    },
  );
  it.each([{ uploads: 1 }, { retained: 1 }])("never discards attachments: %j", (extra) => {
    const input = { ...fresh, html: "<p></p>", ...extra };
    expect(canChooseNativePlainText(input)).toBe(false);
    expect(() => nativePlainTextSaveFields(input)).toThrow();
  });
});
