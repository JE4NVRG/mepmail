import { isPixInvoice, type PixStripe } from "@millionsend/billing";
import { buildAccountMail, claimNotification, DAY_MS, formatMailDate } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { mailOwners, type SystemMailer } from "../system-mail.js";

const KIND = "billing.pix_invoice" as const;
/** A Pix invoice still open this close to its due date is mailed once more. */
export const PIX_INVOICE_REMINDER_MS = DAY_MS;
/** Open invoices read per sweep, at most (pages of 100). */
const MAX_PAGES = 10;

/**
 * With notifications.sweep: every open invoice of a plan paid by Pix (billing pix.ts) is
 * mailed to the team's owners when it is issued, and once more the day before it is
 * due, with the way to pay it in Billing. Claimed per invoice and step: at most once each.
 */
export async function remindPixInvoices(
  db: Db,
  deps: {
    mailer: SystemMailer;
    stripe: PixStripe;
    appBaseUrl?: string | undefined;
    now?: Date | undefined;
  },
): Promise<{ sent: number }> {
  const now = deps.now ?? new Date();
  let sent = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = await deps.stripe.invoices.list({
      status: "open",
      collection_method: "send_invoice",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const invoice of list.data) {
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : (invoice.customer?.id ?? null);
      if (!isPixInvoice(invoice) || invoice.currency !== "brl" || !invoice.due_date || !customerId)
        continue;
      const [team] = await db
        .select({ id: schema.teams.id, name: schema.teams.name })
        .from(schema.teams)
        .where(eq(schema.teams.stripeCustomerId, customerId));
      if (!team) continue;
      const due = new Date(invoice.due_date * 1000);
      const step = due.getTime() - now.getTime() <= PIX_INVOICE_REMINDER_MS ? "due" : "issued";
      if (
        !(await claimNotification(db, {
          teamId: team.id,
          kind: KIND,
          periodKey: `${invoice.id}:${step}`,
        }))
      )
        continue;
      const mailbox = invoice.parent?.subscription_details?.metadata?.mepmail_service === "mailbox";
      try {
        await mailOwners(db, deps.mailer, team.id, KIND, (locale) =>
          buildAccountMail({
            kind: KIND,
            locale,
            url: `${deps.appBaseUrl ?? ""}/settings/billing`,
            values: {
              team: team.name,
              service: mailbox ? "MepMail Correio" : "MepMail",
              amount: new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(
                invoice.amount_remaining / 100,
              ),
              date: formatMailDate(locale, due),
            },
          }),
        );
        sent += 1;
      } catch (err) {
        console.error(`notifications.sweep: ${KIND} for team ${team.id} failed`, err);
      }
    }
    if (!list.has_more) break;
    startingAfter = list.data.at(-1)?.id;
    if (!startingAfter) break;
  }
  return { sent };
}
