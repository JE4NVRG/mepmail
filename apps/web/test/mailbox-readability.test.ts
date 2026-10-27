import { readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxRail } from "@/app/(dashboard)/mailboxes/mailbox-rail";
import { RAIL_SEARCH_THRESHOLD } from "@/lib/mailbox-rail";
import en from "../messages/en/mailboxes.json";
import pt from "../messages/pt-BR/mailboxes.json";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "pt-BR",
  cursor: 0,
  states: {} as Record<number, unknown>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "readability-fixture",
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = h.cursor++;
    const state = Object.hasOwn(h.states, index)
      ? h.states[index]
      : typeof initial === "function"
        ? initial()
        : initial;
    return [
      state,
      (next: unknown) => {
        h.states[index] = typeof next === "function" ? next(state) : next;
      },
    ];
  },
}));
vi.mock("next-intl", async (original) => ({
  ...(await original<typeof import("next-intl")>()),
  useTranslations: () =>
    createTranslator({
      locale: h.locale,
      messages: { mailboxes: h.locale === "en" ? en : pt },
      namespace: "mailboxes",
    }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children),
}));
vi.mock("@/components/popover-menu", () => ({ PopoverMenu: () => null }));
vi.mock("@/app/(dashboard)/mailboxes/mailbox-help-menu", () => ({ MailboxHelpMenu: () => null }));
vi.mock("@/app/(dashboard)/mailboxes/mailbox-folder-icon", () => ({
  MailboxFolderIcon: () => createElement("svg", { "aria-hidden": true }),
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
const target = {
  id: "long-mailbox",
  kind: "person" as const,
  label: "Atendimento da equipe de projetos e integrações",
  address: "atendimento.projetos@empresa-com-nome-completo.example.test",
};
function props(): Parameters<typeof MailboxRail>[0] {
  return {
    boxes: [target],
    selectedId: target.id,
    scope: "all",
    folder: "inbox",
    unread: { [target.id]: 7 },
    inboxUnread: 7,
    schedules: null,
    expanded: false,
    onClose: vi.fn(),
    onSelectBox: vi.fn(),
    onScope: vi.fn(),
    onFolder: vi.fn(),
    dropProps: () => ({}),
    boxesMenu: [],
    boxMenu: [],
    folders: null,
    usage: null,
    onShortcuts: vi.fn(),
  };
}
function rail(input = props()) {
  h.cursor = 0;
  const tree = MailboxRail(input);
  return { tree, html: renderToStaticMarkup(tree), input };
}
function openSwitcher(input = props()) {
  const trigger = nodes(rail(input).tree).find(
    (node) =>
      node.type === "button" && node.props["aria-controls"] === "readability-fixture-box-picker",
  );
  if (!trigger) throw new Error("Missing mailbox switcher");
  expect(trigger.props["aria-expanded"]).toBe(false);
  (trigger.props.onClick as () => void)();
  const opened = rail(input);
  expect(
    nodes(opened.tree).find(
      (node) => node.props["aria-controls"] === "readability-fixture-box-picker",
    )?.props["aria-expanded"],
  ).toBe(true);
  return opened;
}
beforeEach(() => {
  h.states = {};
  h.cursor = 0;
});

describe.each(["en", "pt-BR"] as const)("readable mailbox identity in %s", (locale) => {
  beforeEach(() => {
    h.locale = locale;
  });
  it("keeps the full name, secondary address and unread context available on the native selection button", () => {
    const { tree, html, input } = openSwitcher();
    const button = nodes(tree).find(
      (node) => node.type === "button" && node.props["data-mailbox-id"] === target.id,
    );
    if (!button) throw new Error("Missing mailbox selection button");
    expect(button.props["aria-label"]).toContain(target.label);
    expect(button.props["aria-label"]).toContain("7");
    expect(button.props["aria-current"]).toBe("page");
    const visibleLabels = nodes(button)
      .filter((node) => node.type === "span")
      .map((node) => node.props.children);
    expect(visibleLabels).toContain(target.label);
    expect(visibleLabels).toContain(target.address);
    expect(html).toContain(target.address);
    (button.props.onClick as () => void)();
    expect(input.onSelectBox).toHaveBeenCalledExactlyOnceWith(target.id);
  });
  it("retains the identifiable name and address after filtering a large mailbox collection", () => {
    const input = props();
    input.boxes = [
      target,
      ...Array.from({ length: RAIL_SEARCH_THRESHOLD + 1 }, (_, index) => ({
        id: `box-${index}`,
        kind: "person" as const,
        label: `Sales ${index}`,
        address: `sales${index}@example.test`,
      })),
    ];
    const search = nodes(openSwitcher(input).tree).find(
      (node) => node.type === "input" && node.props.type === "search",
    );
    if (!search) throw new Error("Missing mailbox search");
    expect(search.props["aria-label"]).toBeTruthy();
    (search.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "atendimento.projetos" },
    });
    const filtered = rail(input);
    expect(filtered.html).toContain(target.label);
    expect(filtered.html).toContain(target.address);
    expect(filtered.html).not.toContain("sales0@example.test");
    expect(input.onSelectBox).not.toHaveBeenCalled();
  });
});

const components = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");
const colors = readFileSync(new URL("../src/styles/tokens/colors.css", import.meta.url), "utf8");
function luminance(hex: string) {
  const values = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
}
function contrast(first: string, second: string) {
  const low = Math.min(luminance(first), luminance(second));
  const high = Math.max(luminance(first), luminance(second));
  return (high + 0.05) / (low + 0.05);
}
describe("active input placeholder contrast across existing themes", () => {
  const [dark = "", light = ""] = colors.split(':root[data-theme="light"],');
  it.each([
    ["dark", dark],
    ["light", light],
  ])("meets normal-text contrast against each %s input/search surface", (_mode, palette) => {
    const body = /\.ms-input::placeholder\s*\{([^}]+)\}/.exec(components)?.[1] ?? "";
    const colorToken = /color:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    if (!colorToken) throw new Error("Missing placeholder foreground token");
    const hex = (name: string) => {
      const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(palette)?.[1];
      if (!value) throw new Error(`Missing ${name} in theme`);
      return value;
    };
    for (const surface of ["--ms-void", "--ms-panel", "--ms-inset"])
      expect(contrast(hex(colorToken), hex(surface)), surface).toBeGreaterThanOrEqual(4.5);
    expect(body).toMatch(/opacity:\s*1\s*;/);
  });
});
