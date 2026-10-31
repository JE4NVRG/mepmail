import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en/common.json";
import pt from "../messages/pt-BR/common.json";
import { ApiSendsScope } from "../src/components/api-sends-scope";
import { SendingPausedBanner } from "../src/components/sending-paused-banner";
import { sendingClarityEnglish } from "../src/lib/sending-clarity";

const io = vi.hoisted(() => ({ state: "normal" }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { state: io.state } }) }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({ system: { sendingAvailability: { queryOptions: () => ({}) } } }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string }) =>
    createElement("a", props, children),
}));
function render(locale: string, messages: unknown, node: ReactNode) {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: { common: messages } as never,
      timeZone: "UTC",
      children: node,
    }),
  );
}
for (const [locale, messages] of [
  ["en", en],
  ["pt-BR", pt],
] as const)
  describe(locale, () => {
    it("does not show a global pause for an admitted limited route", () => {
      io.state = "limited";
      const html = render(locale, messages, createElement(SendingPausedBanner));
      expect(html).toContain(messages.sendingPaused.limitedText);
      expect(html).not.toContain(messages.sendingPaused.scopeText);
      expect(html).toContain('role="status"');
      expect(html).not.toMatch(/Amazon|Azure|allowedTeamIds|recipientHash/);
    });
    it("shows an accurate hold without promising automatic replay", () => {
      io.state = "paused";
      const html = render(locale, messages, createElement(SendingPausedBanner));
      expect(html).toContain(messages.sendingPaused.scopeText);
      expect(html).not.toMatch(/go out on their own|saem sozinhos|Nothing is lost|Nada se perde/);
    });
    it("stays quiet for normal legacy sending", () => {
      io.state = "normal";
      expect(render(locale, messages, createElement(SendingPausedBanner))).toBe("");
    });
    it("explains API coverage and honestly opens the mailbox landing", () => {
      const html = render(locale, messages, createElement(ApiSendsScope));
      expect(html).toContain(messages.apiSends.description);
      expect(html).toContain(messages.apiSends.mailLink);
      expect(html).toContain('href="/mail"');
      expect(html).toContain("SMTP");
    });
  });
it("uses honest English fallback for existing locales without the new keys", () => {
  io.state = "limited";
  const html = render(
    "fr",
    { sendingPaused: { text: "OBSOLETE" } },
    createElement(SendingPausedBanner),
  );
  expect(html).toContain(sendingClarityEnglish["sendingPaused.limitedText"]);
  expect(html).not.toContain("OBSOLETE");
});
