import type { Period } from "@/components/console/chart-dialog";

const DAY_MS = 86_400_000;

/** A ratio as a percentage with exactly `decimals` places ("98.5%" / "98,5%"). */
export function formatPercent(value: number, locale: string, decimals: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** A delta ratio with its sign ("+8.1%", "-2.0%"). */
export function formatSignedPercent(value: number, locale: string, decimals: number): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: "exceptZero",
  }).format(value);
}

/** Local wall-clock label for an hourly point ("14:00" / "2:00 PM"). */
export function formatHourMinute(date: Date | string | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(date),
  );
}

export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

/** The largest whole unit a duration in seconds reads in, for the console.common.duration.* catalog. */
export function durationUnit(seconds: number): { unit: DurationUnit; n: number } {
  if (seconds < 60) return { unit: "seconds", n: Math.round(seconds) };
  if (seconds < 3_600) return { unit: "minutes", n: Math.round(seconds / 60) };
  if (seconds < 86_400) return { unit: "hours", n: Math.round(seconds / 3_600) };
  return { unit: "days", n: Math.round(seconds / 86_400) };
}

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The UTC day keys a console period spans, oldest first. Mirrors the
 * server's resolvePeriod + dayKeys (apps/web/src/server/console/periods.ts)
 * so a per-day series can be zero-filled on the client.
 */
export function periodDayKeys(period: Period, now: Date = new Date()): string[] {
  let from: number;
  let to = now.getTime();
  if (period === "24h") {
    from = to - DAY_MS;
  } else if (typeof period === "string") {
    const days = { "7d": 7, "30d": 30, "90d": 90 }[period];
    from = Date.parse(`${utcDay(to - (days - 1) * DAY_MS)}T00:00:00Z`);
  } else {
    from = Date.parse(`${period.from}T00:00:00Z`);
    to = Math.min(to, Date.parse(`${period.to}T23:59:59.999Z`));
  }
  const out: string[] = [];
  for (let t = Date.parse(utcDay(from)); t <= to; t += DAY_MS) out.push(utcDay(t));
  return out;
}
