import { describe, expect, it } from "vitest";
import {
  cleanQuickReplies,
  QUICK_REPLY_LIMITS,
  quickRepliesSchema,
  undoSendSchema,
  withQuickReply,
} from "./mailbox-quick-replies";

describe("mailbox quick replies", () => {
  it("cleans what the editor holds the way the server stores it", () => {
    expect(cleanQuickReplies(["  Obrigado! ", "", "Combinado.", "Obrigado!"])).toEqual([
      "Obrigado!",
      "Combinado.",
    ]);
    expect(cleanQuickReplies([])).toEqual([]);
  });

  it("refuses lists past the limits instead of cutting them silently", () => {
    expect(cleanQuickReplies(["x".repeat(QUICK_REPLY_LIMITS.chars + 1)])).toBeNull();
    expect(
      cleanQuickReplies(Array.from({ length: QUICK_REPLY_LIMITS.count + 1 }, (_, i) => `r${i}`)),
    ).toBeNull();
    // Eight full lines of four-byte characters pass the count and length checks
    // but not the byte budget the preferences object can hold.
    expect(cleanQuickReplies(Array.from({ length: 8 }, (_, i) => `${i}${"😀".repeat(79)}`))).toBe(
      null,
    );
  });

  it("accepts null as the built-in set and rejects other shapes", () => {
    expect(quickRepliesSchema.safeParse(null).success).toBe(true);
    expect(quickRepliesSchema.safeParse(["ok"]).success).toBe(true);
    expect(quickRepliesSchema.safeParse([""]).success).toBe(false);
    expect(quickRepliesSchema.safeParse("ok").success).toBe(false);
    expect(quickRepliesSchema.safeParse([1]).success).toBe(false);
  });

  it("offers only the undo-send delays the settings list", () => {
    expect(undoSendSchema.safeParse(10).success).toBe(true);
    expect(undoSendSchema.safeParse(0).success).toBe(true);
    expect(undoSendSchema.safeParse(7).success).toBe(false);
    expect(undoSendSchema.safeParse("10").success).toBe(false);
  });

  it("puts the quick reply above the signature or the quote", () => {
    expect(withQuickReply("\n\n--\nAna\n\n> oi", " Obrigado! ")).toBe(
      "Obrigado!\n\n--\nAna\n\n> oi",
    );
    expect(withQuickReply("", "Combinado.")).toBe("Combinado.\n\n");
    expect(withQuickReply("\n\n> oi", "  ")).toBe("\n\n> oi");
  });
});
