import en from "../../messages/en/reputation.json";
import pt from "../../messages/pt-BR/reputation.json";

export type ReputationState =
  | "unverified"
  | "verified"
  | "domain_verified"
  | "established"
  | "suspended";
export interface ReputationSnapshot {
  state: ReputationState;
  plan?: string;
  nominalMonthly?: number | null;
  dailyLeft?: number | null;
  recipientWindows?: Array<{
    hours: 1 | 24 | 168;
    limit: number;
    used: number;
    left: number;
    retryAfterSeconds: number;
  }>;
  capacityAvailable?: boolean;
  nextStep?: string;
  nominalPlanDaily: number | null;
  effectiveDaily: number | null;
  effectiveMinute: number | null;
  usedToday: number | null;
  volume24h: number | null;
  complaints: { count: number | null; denominator: number | null; rate?: number | null };
  bounces: { count: number | null; denominator: number | null; rate?: number | null };
  newRecipients: { hour: number | null; day: number | null; week: number | null };
  warmupPercent: number | null;
  nextDailyLimit: number | null;
  nextEligibleAt: string | null;
  campaignEligible: boolean | null;
  capacityKnown: boolean;
  refusal:
    | "domain_required"
    | "recipient_restricted"
    | "daily_limit"
    | "capacity_unknown"
    | "review_required"
    | "verify_identity"
    | "warming"
    | null;
}
export type ReputationPanelProps = { locale: string } & (
  | { status: "ready"; snapshot: ReputationSnapshot }
  | { status: "loading" | "unavailable" | "error" | "forbidden"; snapshot?: never }
);
/** Read-only projection of an authenticated own-team snapshot. No identity or raw error is accepted. */
export function ReputationPanel(props: ReputationPanelProps) {
  const t = props.locale === "pt-BR" ? pt : en;
  const number = (value: number | null) =>
    value !== null && Number.isSafeInteger(value) && value >= 0
      ? value.toLocaleString(props.locale)
      : t.unknown;
  const rate = (metric: ReputationSnapshot["complaints"]) => {
    const { count, denominator } = metric;
    if (metric.rate !== undefined)
      return metric.rate !== null &&
        Number.isFinite(metric.rate) &&
        metric.rate >= 0 &&
        metric.rate <= 1 &&
        denominator !== null &&
        denominator > 0
        ? `${new Intl.NumberFormat(props.locale, { maximumFractionDigits: 3 }).format(metric.rate * 100)}%`
        : t.unknown;
    if (
      count === null ||
      denominator === null ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(denominator) ||
      count < 0 ||
      denominator <= 0 ||
      count > denominator
    )
      return t.unknown;
    return `${new Intl.NumberFormat(props.locale, { maximumFractionDigits: 3 }).format((count / denominator) * 100)}%`;
  };
  if (props.status !== "ready")
    return (
      <section className="ms-card" aria-label={t.title} aria-busy={props.status === "loading"}>
        <h2>{t.title}</h2>
        <p role="status">{t[props.status]}</p>
      </section>
    );
  const s = props.snapshot;
  const date =
    s.nextEligibleAt && Number.isFinite(Date.parse(s.nextEligibleAt))
      ? new Date(s.nextEligibleAt).toLocaleString(props.locale, { timeZone: "UTC" }) + " UTC"
      : t.unknown;
  const systemPlan = s.plan === "system";
  const systemAware = (value: number | null | undefined) =>
    systemPlan && value === null ? t.unlimited : number(value ?? null);
  const rows = [
    [t.plan, systemPlan ? t.systemPlan : (s.plan ?? t.unknown)],
    [t.monthly, systemAware(s.nominalMonthly)],
    [t.left, systemAware(s.dailyLeft)],
    [
      t.capacity,
      s.capacityAvailable === undefined
        ? t.unknown
        : s.capacityAvailable
          ? t.available
          : t.notAvailable,
    ],
    [t.nextStep, t.steps[s.nextStep as keyof typeof t.steps] ?? t.unknown],
    [t.state, t.states[s.state]],
    [t.nominal, systemAware(s.nominalPlanDaily)],
    [t.effective, s.capacityKnown ? systemAware(s.effectiveDaily) : t.unknown],
    [t.minute, s.capacityKnown ? systemAware(s.effectiveMinute) : t.unknown],
    [t.used, number(s.usedToday)],
    [t.volume, number(s.volume24h)],
    [
      t.complaints,
      `${rate(s.complaints)} · ${s.complaints.rate !== undefined ? t.denominator : number(s.complaints.count)} / ${number(s.complaints.denominator)}`,
    ],
    [
      t.bounces,
      `${rate(s.bounces)} · ${s.bounces.rate !== undefined ? t.denominator : number(s.bounces.count)} / ${number(s.bounces.denominator)}`,
    ],
    [
      t.recipients,
      `${number(s.newRecipients.hour)} / 1h · ${number(s.newRecipients.day)} / 24h · ${number(s.newRecipients.week)} / 7d`,
    ],
    [
      t.warmup,
      s.warmupPercent !== null && [0, 25, 50, 75, 100].includes(s.warmupPercent)
        ? `${s.warmupPercent}%`
        : t.unknown,
    ],
    [t.next, number(s.nextDailyLimit)],
    [t.eligibleAt, date],
    [
      t.campaign,
      s.campaignEligible === null ? t.unknown : s.campaignEligible ? t.eligible : t.notEligible,
    ],
  ];
  return (
    <section className="ms-card" aria-label={t.title}>
      <h2>{t.title}</h2>
      <p>{t.readonly}</p>
      {!s.capacityKnown ? <p role="status">{t.capacityUnknown}</p> : null}
      {s.refusal ? <p role="status">{t.refusals[s.refusal]}</p> : null}
      <dl style={{ display: "grid", gap: "0.75rem", maxWidth: 720 }}>
        {rows.map(([label, value]) => (
          <div
            key={label}
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: "0.5rem 1rem",
              overflowWrap: "anywhere",
            }}
          >
            <dt style={{ color: "var(--ms-muted)" }}>{label}</dt>
            <dd style={{ margin: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
      <p>{t.progression}</p>
      <p>{t.thresholds}</p>
    </section>
  );
}
