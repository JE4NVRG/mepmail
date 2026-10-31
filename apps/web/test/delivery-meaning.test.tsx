import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enCommon from "../messages/en/common.json";
import enMailbox from "../messages/en/mailboxes.json";
import ptCommon from "../messages/pt-BR/common.json";
import ptMailbox from "../messages/pt-BR/mailboxes.json";
import { emailStatusColor } from "../src/components/email-status-icon";
import { StatusBadge } from "../src/components/status-badge";
import { mailboxDeliveryLabel } from "../src/lib/mailbox-delivery-status";

function lookup(catalog: unknown, key: string): string {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, catalog);
  if (typeof value !== "string") throw new Error(`Missing fixture translation: ${key}`);
  return value;
}

const locale = vi.hoisted(() => ({ current: "en" }));
vi.mock("next-intl", () => ({
  useTranslations: () => {
    const catalog = locale.current === "en" ? enCommon : ptCommon;
    return (key: string) => lookup(catalog, key);
  },
}));

const unconfirmed = {
  totalRecipients: 1,
  delivered: 0,
  delayed: 0,
  hardBounce: 0,
  complaint: 0,
  softBounce: 0,
  rejected: 0,
  renderingFailed: 0,
  unconfirmed: 1,
};

for (const [language, common, mailbox, label, disclosure] of [
  [
    "en",
    enCommon,
    enMailbox,
    "Received by recipient server",
    "Inbox placement and reading are not confirmed.",
  ],
  [
    "pt-BR",
    ptCommon,
    ptMailbox,
    "Recebido pelo servidor destinatário",
    "Caixa de Entrada e leitura não confirmadas.",
  ],
] as const) {
  describe(language, () => {
    it("names server receipt, not Inbox or reading, in actual API badges and Mail Sent labels", () => {
      locale.current = language;
      expect(common.status.delivered).toBe(label);
      const markup = renderToStaticMarkup(<StatusBadge status="delivered" />);
      expect(markup).toContain(label);
      expect(markup).toContain("ms-badge-neutral");
      expect(markup).toContain("min-width:140px");
      expect(common.deliveryDisclosure).toBe(disclosure);
      const t = Object.assign((key: string) => lookup(mailbox, key), { has: () => true });
      expect(
        mailboxDeliveryLabel(t, "accepted", { ...unconfirmed, delivered: 1, unconfirmed: 0 }),
      ).toBe(label);
      expect(mailbox.results.noReading).toBe(disclosure);
      for (const status of ["unknown", "accepted", "queued", "sending", "failed"]) {
        expect(mailboxDeliveryLabel(t, status, unconfirmed)).not.toBe(label);
      }
      expect(mailboxDeliveryLabel(t, "unknown", null)).not.toBe(label);
      expect(mailboxDeliveryLabel(t, "unknown", { ...unconfirmed, delivered: 2 })).not.toBe(label);
    });
    it("keeps existing opened/clicked evidence separate from delivered", () => {
      locale.current = language;
      for (const status of ["opened", "clicked"] as const) {
        const markup = renderToStaticMarkup(<StatusBadge status={status} />);
        expect(markup).toContain(common.status[status]);
        expect(markup).toContain("ms-badge-info");
        expect(markup).not.toContain(label);
      }
      expect(renderToStaticMarkup(<StatusBadge status="verified" />)).toContain("ms-badge-success");
    });
  });
}

it("exposes server receipt limits as visible API detail copy, including a delivered event before later engagement", () => {
  const detail = readFileSync(
    new URL("../src/app/(dashboard)/emails/[id]/page.tsx", import.meta.url),
    "utf8",
  );
  expect(detail).toContain(
    'email.latestStatus === "delivered" || events.some((event) => event.type === "delivered")',
  );
  expect(detail).toMatch(
    /<p[^>]*>[\s\S]*?common\("status.delivered"\)[\s\S]*?common\("deliveryDisclosure"\)[\s\S]*?<\/p>/,
  );
  expect(detail).toContain('whiteSpace: type === "delivered" ? "normal" : "nowrap"');
  expect(detail).toContain('delivered: "var(--ms-neutral)"');
});

it("guards the actual list and Mail Sent detail consumers, not an unused label", () => {
  const table = readFileSync(
    new URL("../src/components/emails-table.tsx", import.meta.url),
    "utf8",
  );
  const mailbox = readFileSync(
    new URL("../src/app/(dashboard)/mailboxes/mailbox-content-view.tsx", import.meta.url),
    "utf8",
  );
  expect(table).toContain("<StatusBadge status={row.latestStatus} />");
  expect(mailbox).toContain("mailboxDeliveryLabel(t, row.sendStatus, row.outboundSummary)");
  expect(mailbox).toContain("mailboxDeliveryLabel(t, item.sendStatus, item.outboundSummary)");
  expect(mailbox).toMatch(/<dt>\{t\(`results\.\$\{row\.key\}`\)\}<\/dt>/);
  expect(mailbox).toContain('<p>{t("results.noReading")}</p>');
});

it("does not use the green success/read-like tone for server receipt", () => {
  expect(emailStatusColor("delivered")).toBe("var(--ms-neutral)");
  expect(emailStatusColor("opened")).toBe("var(--ms-info)");
  expect(emailStatusColor("clicked")).toBe("var(--ms-info)");
  expect(emailStatusColor("unknown")).toBe("var(--ms-muted)");
});
