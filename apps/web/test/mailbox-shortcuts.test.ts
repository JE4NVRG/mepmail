import { describe, expect, it } from "vitest";
import { MAILBOX_SHORTCUTS, mailboxShortcut } from "@/lib/mailbox-shortcuts";

const press = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  isComposing: false,
  repeat: false,
  ...extra,
});
const inside = (selectorHit: boolean) =>
  ({ closest: () => (selectorHit ? {} : null) }) as unknown as EventTarget;

describe("Correio keyboard shortcuts", () => {
  it("maps the webmail keys", () => {
    expect(mailboxShortcut(press("j"), null)).toBe("next");
    expect(mailboxShortcut(press("k"), null)).toBe("previous");
    expect(mailboxShortcut(press("Escape"), null)).toBe("close");
    expect(mailboxShortcut(press("e"), null)).toBe("archive");
    expect(mailboxShortcut(press("#"), null)).toBe("trash");
    expect(mailboxShortcut(press("r"), null)).toBe("reply");
    expect(mailboxShortcut(press("a"), null)).toBe("replyAll");
    expect(mailboxShortcut(press("f"), null)).toBe("forward");
    expect(mailboxShortcut(press("c"), null)).toBe("compose");
    expect(mailboxShortcut(press("/"), null)).toBe("search");
    expect(mailboxShortcut(press("?"), null)).toBe("help");
    expect(mailboxShortcut(press("z"), null)).toBe("undo");
    expect(mailboxShortcut(press("v"), null)).toBe("moveTo");
    expect(mailboxShortcut(press("N"), null)).toBe("newFolder");
  });

  it("leaves typing, modifiers, repeats and dialogs alone", () => {
    expect(mailboxShortcut(press("r"), inside(true))).toBeNull();
    expect(mailboxShortcut(press("r"), inside(false))).toBe("reply");
    expect(mailboxShortcut(press("r", { ctrlKey: true }), null)).toBeNull();
    expect(mailboxShortcut(press("c", { metaKey: true }), null)).toBeNull();
    expect(mailboxShortcut(press("e", { altKey: true }), null)).toBeNull();
    expect(mailboxShortcut(press("j", { repeat: true }), null)).toBeNull();
    expect(mailboxShortcut(press("j", { isComposing: true }), null)).toBeNull();
    expect(mailboxShortcut(press("j", { defaultPrevented: true }), null)).toBeNull();
  });

  it("ignores other keys and capitals, and lists every action once", () => {
    expect(mailboxShortcut(press("R"), null)).toBeNull();
    expect(mailboxShortcut(press("x"), null)).toBeNull();
    expect(mailboxShortcut(press("toString"), null)).toBeNull();
    const listed = MAILBOX_SHORTCUTS.map((entry) => entry.action);
    expect(new Set(listed).size).toBe(listed.length);
  });
});
