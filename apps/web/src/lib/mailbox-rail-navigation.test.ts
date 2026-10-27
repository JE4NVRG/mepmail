import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../messages/en/mailboxes.json";
import pt from "../../messages/pt-BR/mailboxes.json";
import { MailboxRail } from "../app/(dashboard)/mailboxes/mailbox-rail";

type Props = ComponentProps<typeof MailboxRail>;
const boxes = (count: number): Props["boxes"] =>
  Array.from({ length: count }, (_, i) => ({
    id: `box-${i}`,
    label: `Mailbox ${i}`,
    address: `mailbox-${i}@example.test`,
    kind: i % 3 === 0 ? "agent" : "person",
  }));
const props = (count = 40): Props => ({
  boxes: boxes(count),
  selectedId: null,
  scope: "all",
  folder: "inbox",
  unread: {},
  inboxUnread: 7,
  schedules: { snoozed: 2, scheduled: 3, followUps: 4 },
  expanded: false,
  onClose() {},
  onSelectBox() {},
  onScope() {},
  onFolder() {},
  onShortcuts() {},
  dropProps: ({ folder }) => ({ "data-drop-target": folder }),
  boxesMenu: [],
  boxMenu: [],
  folders: null,
  usage: null,
});
function render(overrides: Partial<Props> = {}, locale = "pt-BR") {
  // next-intl requires children in the typed SSR provider props.
  const providerProps: ComponentProps<typeof NextIntlClientProvider> = {
    locale,
    timeZone: "UTC",
    messages: { mailboxes: locale === "en" ? en : pt },
    children: createElement(MailboxRail, { ...props(), ...overrides }),
  };
  return renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps));
}
function folderOrder(html: string) {
  return [...html.matchAll(/data-mailbox-folder="([^"]+)"/g)].map((m) => m[1]);
}

describe("Correio primary navigation", () => {
  it.each([0, 1, 12, 40, 120])(
    "keeps Sent second without rendering %i mailbox rows ahead of folders",
    (count) => {
      const html = render({ boxes: boxes(count) });
      expect(folderOrder(html)).toEqual([
        "inbox",
        "sent",
        "drafts",
        "favorites",
        "archive",
        "trash",
      ]);
      expect(html).not.toContain("data-mailbox-picker-panel");
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain('data-mailbox-scope="all"');
      expect(html).toContain('data-folder="inbox"');
    },
  );
  it("identifies the selected mailbox without exposing other mailbox rows", () => {
    const html = render({ selectedId: "box-39" });
    expect(html).toContain('data-mailbox-id="box-39"');
    expect(html).toContain("mailbox-39@example.test");
    expect(html).not.toContain("mailbox-38@example.test");
    expect(html).toContain('data-mailbox-scope="selected"');
  });
  it.each(["snoozed", "followups", "scheduled", "spam", "quarantine"] as const)(
    "opens secondary navigation for an active %s folder",
    (folder) => {
      const html = render({ folder });
      expect(folderOrder(html)).toEqual([
        "inbox",
        "sent",
        "drafts",
        "favorites",
        "archive",
        "snoozed",
        "followups",
        "scheduled",
        "spam",
        "quarantine",
        "trash",
      ]);
      expect(html).toMatch(new RegExp(`aria-current="page"[^>]*data-mailbox-folder="${folder}"`));
    },
  );
  it("preserves drop eligibility and unread accessibility", () => {
    const html = render();
    expect(html).toContain('data-drop-target="inbox"');
    expect(html).toContain('data-drop-target="archive"');
    expect(html).not.toContain('data-drop-target="sent"');
    expect(html).toMatch(/data-mailbox-folder="inbox" aria-label="[^"]*7/);
  });
  it("uses the existing English labels and stable agent-facing folder identifiers", () => {
    const html = render({}, "en");
    expect(html).toContain('data-mailbox-folder="sent" aria-label="Sent"');
    expect(html).toContain('data-mailbox-folder="drafts" aria-label="Drafts"');
  });
});
