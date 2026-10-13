import type { PixStripe } from "@millionsend/billing";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { remindPixInvoices } from "../src/handlers/pix-invoices.js";

// The worker has no Stripe SDK of its own: the invoice type comes through billing.
type Invoice = Awaited<ReturnType<PixStripe["invoices"]["retrieve"]>>;

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string }[];
const NOW = new Date("2026-11-02T12:00:00Z");
const day = 86_400;

const invoice = (id: string, extra: Partial<Invoice> = {}) =>
  ({
    id,
    object: "invoice",
    customer: "cus_pix_team",
    status: "open",
    currency: "brl",
    collection_method: "send_invoice",
    amount_remaining: 1490,
    due_date: Math.floor(NOW.getTime() / 1000) + 4 * day,
    parent: {
      subscription_details: {
        subscription: "sub_pix",
        metadata: { mepmail_service: "mailbox", mepmail_collection: "pix" },
      },
    },
    ...extra,
  }) as unknown as Invoice;

const stripe = (invoices: Invoice[]) =>
  ({
    invoices: {
      list: async () => ({ object: "list", has_more: false, data: invoices }),
    },
  }) as unknown as PixStripe;

const remind = (invoices: Invoice[], now = NOW) =>
  remindPixInvoices(db, {
    mailer: {
      send: async (to: string, m: { subject: string; text: string }) => {
        sends.push({ to, subject: m.subject, text: m.text });
      },
    },
    stripe: stripe(invoices),
    appBaseUrl: "https://app.example.test",
    now,
  });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "pix-team");
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: "cus_pix_team" })
    .where(eq(schema.teams.id, teamId));
  sends = [];
});
afterEach(async () => {
  await close();
});

it("mails an open Pix invoice when issued and again the day before it is due", async () => {
  const open = invoice("in_pix_renewal");
  expect(await remind([open])).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "owner@example.com" });
  expect(sends[0]?.subject).toContain("MepMail Correio");
  expect(sends[0]?.text).toContain("https://app.example.test/settings/billing");
  // The next sweeps of the same day stay quiet.
  expect(await remind([open])).toEqual({ sent: 0 });
  const dayBefore = new Date(NOW.getTime() + 3.5 * day * 1000);
  expect(await remind([open], dayBefore)).toEqual({ sent: 1 });
  expect(await remind([open], dayBefore)).toEqual({ sent: 0 });
});

it("ignores card invoices, other currencies and customers that are not a team", async () => {
  const card = invoice("in_card", { collection_method: "charge_automatically" });
  const notPix = invoice("in_send_invoice", {
    parent: { subscription_details: { metadata: {} } },
  } as unknown as Partial<Invoice>);
  const usd = invoice("in_usd", { currency: "usd" });
  const stranger = invoice("in_stranger", { customer: "cus_unknown" });
  expect(await remind([card, notPix, usd, stranger])).toEqual({ sent: 0 });
  expect(sends).toEqual([]);
});
