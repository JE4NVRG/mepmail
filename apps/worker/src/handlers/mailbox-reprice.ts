import {
  type MailboxCatalog,
  type MailboxRepriceDeps,
  type MailboxRepricedChange,
  repriceMailboxAddOnsWithoutSending,
} from "@millionsend/billing";
import {
  buildAccountMail,
  claimNotification,
  formatMailDate,
  type MailLocale,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import type { MailboxLaunchCohort } from "../../../../packages/core/src/mailbox-launch-cohort.js";
import { mailOwners, type SystemMailer } from "../system-mail.js";

function money(locale: MailLocale, cents: number, currency: string, interval: "month" | "year") {
  const amount = new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : "en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "code",
  })
    .format(cents / 100)
    .replace(/^USD\s?/, "US$ ")
    .replace(/\s?USD$/, "")
    .trim();
  const per =
    locale === "pt-BR"
      ? interval === "year"
        ? "por ano"
        : "por mês"
      : interval === "year"
        ? "a year"
        : "a month";
  return `${amount} ${per}`;
}

/**
 * Daily, with billing.reconcile: Correio add-on contracts whose team has gone
 * without a paid Envio plan past the grace move to the standalone price at the
 * next renewal, and the owners are told once per subscription.
 */
export async function runMailboxReprice(
  db: Db,
  deps: {
    stripe: MailboxRepriceDeps["stripe"];
    catalog: MailboxCatalog;
    cohort: MailboxLaunchCohort | null | undefined;
    mailer: SystemMailer;
    appBaseUrl: string;
  },
) {
  const notify = async (change: MailboxRepricedChange) => {
    const claimed = await claimNotification(db, {
      teamId: change.teamId,
      kind: `mailbox.repriced:${change.stripeSubscriptionId}`,
      periodKey: "once",
    });
    if (!claimed) return;
    const [team] = await db
      .select({ name: schema.teams.name })
      .from(schema.teams)
      .where(eq(schema.teams.id, change.teamId));
    await mailOwners(db, deps.mailer, change.teamId, "mailbox.repriced", (locale) =>
      buildAccountMail({
        kind: "mailbox.repriced",
        locale,
        url: `${deps.appBaseUrl}/settings/billing`,
        values: {
          team: team?.name ?? "",
          date: formatMailDate(locale, change.effectiveAt),
          price: money(locale, change.toUnitAmount, change.currency, change.interval),
        },
      }),
    );
  };
  return repriceMailboxAddOnsWithoutSending({
    db,
    stripe: deps.stripe,
    catalog: deps.catalog,
    earlyAccessCohort: deps.cohort,
    notify,
  });
}
