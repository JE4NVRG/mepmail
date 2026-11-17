import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { campaignDomainDnsReady } from "./campaign-consent.js";
import {
  fetchDeliverabilityHealth,
  nativeReputationRows,
  nativeReputationSchemaReady,
} from "./deliverability.js";
import { firstRow } from "./driver-result.js";
import {
  budgetBackedDailyCeiling,
  type CapacityReceipt,
  GraduatedAdmissionError,
  graduatedPolicy,
  parseCapacityReceipt,
  reputationCircuitTriggered,
  type TenantReputationDto,
  tenantSendingMinuteCeiling,
} from "./graduated-sending-policy.js";
import { withMailboxSendAccess } from "./mailbox-private-store.js";
import { teamQuota } from "./plans.js";
import { extractAddrSpec, normalizeAddress } from "./suppressions.js";

const ACTION = "sending.graduated_reserved";
const SEEN = "sending.graduated_recipient_seen";
export interface GraduatedContext {
  clock?: () => Date;
  domainId?: string;
  judgeEnvelope?: Readonly<JudgeOperationalEnvelope>;
  capacityReceipt?: CapacityReceipt;
  regionalCapacity?: Partial<Record<"us-east-1" | "eu-west-1", CapacityReceipt | null>>;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function graduatedSendingEnabled(): boolean {
  const raw = process.env.SENDING_PROVIDER_POLICY_JSON;
  if (!raw) return false;
  // Malformed policy must not silently select the legacy path.
  return (JSON.parse(raw) as { graduated?: unknown }).graduated === true;
}
async function wallClock(db: Db, context?: GraduatedContext): Promise<Date> {
  if (context?.clock) {
    const at = context.clock();
    if (!Number.isFinite(at.getTime())) throw new Error("invalid_server_clock");
    return at;
  }
  const row = firstRow<{ at: string }>(await db.execute(sql`select clock_timestamp()::text as at`));
  const at = new Date(row?.at ?? "");
  if (!Number.isFinite(at.getTime())) throw new Error("graduated_clock_missing");
  return at;
}
/** Read-only team projection. The caller must establish its own-team read permission. */
export async function getTenantReputation(
  db: Db,
  teamId: string,
  context?: GraduatedContext,
): Promise<TenantReputationDto> {
  return (await loadTenant(db, teamId, await wallClock(db, context), context?.domainId, context))
    .dto;
}

/** Metadata-only inventory join. Immutable admissions survive source deletion.
 * Unknown/legacy attribution stays occupied in every potentially owning region.
 * Provider aggregate usage is credited at most once, bounded by confirmed local
 * acknowledgements before the observation origin; it never settles model debt.
 * SES is eventually consistent: this conservative attribution is not an SLA. */
async function sesHeadroom(
  db: Db,
  receipt: CapacityReceipt,
  region: string,
  now: Date,
): Promise<number | null> {
  const r = receipt as CapacityReceipt & {
    issuedAt?: string;
    region?: string;
    dailySemantics?: string;
    buffers?: { sesRemaining24Hours: number; localCommitments: string };
    observations?: { sesSentLast24Hours: number };
  };
  if (!r.buffers && !r.issuedAt && !r.dailySemantics) return null; // legacy configured flow-only ABI
  const origin = Date.parse(r.issuedAt ?? ""),
    expires = Date.parse(r.expiresAt);
  const remaining = r.buffers?.sesRemaining24Hours,
    observed = r.observations?.sesSentLast24Hours;
  if (
    r.region !== region ||
    r.dailySemantics !== "nominal-flow-ceiling-not-resource-guarantee" ||
    r.buffers?.localCommitments !== "parent-ledger-required" ||
    !Number.isFinite(origin) ||
    origin > now.getTime() ||
    expires - origin > 5000 ||
    expires <= now.getTime() ||
    ![remaining, observed].every((n) => Number.isSafeInteger(n) && n! >= 0)
  )
    throw new Error("capacity_accounting_unknown");
  const nativeReady = await nativeReputationSchemaReady(db);
  const nativeOutbox = nativeReady
    ? sql`mailbox_outbox`
    : sql`(
    select null::uuid as id, null::uuid as team_id, null::uuid as mailbox_id,
      null::text as provider_message_id, null::text as status,
      null::timestamptz as accepted_at where false)`;
  const nativeBoxes = nativeReady
    ? sql`mailboxes`
    : sql`(
    select null::uuid as id, null::uuid as team_id, null::text as origin where false)`;
  const row = firstRow<{ held: string; covered: string }>(
    await db.execute(sql`
  with reservations as materialized (
   select a.team_id,a.target,a.created_at,a.data,
    case when a.data->>'units' ~ '^[0-9]{1,15}$' then (a.data->>'units')::bigint else 9007199254740991 end as units
   from ${schema.auditLog} a where a.action=${ACTION} and a.created_at<=${now}
    and (a.data->>'transport' is distinct from 'external')
    and (a.data->>'region' is null or a.data->>'region' not in ('us-east-1','eu-west-1') or a.data->>'region'=${region})
  ), facts as (
   select a.units,a.created_at,a.data->>'region' as reservation_region,
    case when e.ses_message_id is not null and e.sent_at>=a.created_at and e.sent_at<=${now} then e.sent_at
     when event_proof.accepted_at is not null then event_proof.accepted_at
     when o.provider_message_id is not null and o.status='accepted' and o.accepted_at>=a.created_at and o.accepted_at<=${now} and b.origin='domain' then o.accepted_at end as accepted_at,
    b.origin
   from reservations a
   left join ${schema.emails} e on e.id=case when a.target ~ '^graduated:[a-fA-F0-9-]{36}$' then substring(a.target from 11)::uuid end and e.team_id=a.team_id
   left join lateral (select min(v.occurred_at) as accepted_at from ${schema.emailEvents} v
    where v.email_id=e.id and (v.type='sent' or v.sns_message_id is not null)
     and v.occurred_at>=a.created_at and v.occurred_at<=${now} and v.created_at<=${now}) event_proof on true
   left join ${nativeOutbox} o on o.id=case when a.target ~ '^graduated:[a-fA-F0-9-]{36}$' then substring(a.target from 11)::uuid end and o.team_id=a.team_id
   left join ${nativeBoxes} b on b.id=o.mailbox_id and b.team_id=o.team_id
  ) select coalesce(sum(units) filter(where accepted_at is null or accepted_at>${now}::timestamptz-interval '24 hours'),0)::text as held,
   coalesce(sum(units) filter(where accepted_at>${now}::timestamptz-interval '24 hours' and accepted_at<${new Date(origin)} and reservation_region=${region}),0)::text as covered
   from facts where origin is distinct from 'external'
 `),
  );
  const held = Number(row?.held),
    covered = Number(row?.covered);
  if (![held, covered].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("capacity_accounting_unknown");
  return Math.max(0, remaining! - Math.max(0, held - Math.min(covered, observed!)));
}

async function loadTenant(
  db: Db,
  teamId: string,
  now: Date,
  domainId?: string,
  context?: GraduatedContext,
  external = false,
) {
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) throw new Error("graduated_team_missing");
  let [principal] = await db
    .select({
      id: schema.teamSignupRisk.principalUserId,
      email: schema.user.email,
      verified: schema.user.emailVerified,
      level: schema.teamSignupRisk.level,
      clearedAt: schema.teamSignupRisk.clearedAt,
    })
    .from(schema.teamSignupRisk)
    .leftJoin(schema.user, eq(schema.user.id, schema.teamSignupRisk.principalUserId))
    .where(eq(schema.teamSignupRisk.teamId, teamId));
  if (!principal) {
    const owners = await db
      .select({ id: schema.user.id, email: schema.user.email, verified: schema.user.emailVerified })
      .from(schema.teamMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")))
      .limit(2);
    if (owners.length === 1 && owners[0])
      principal = { ...owners[0], level: "sandbox", clearedAt: null };
  }
  const domains = domainId
    ? await db
        .select()
        .from(schema.domains)
        .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.id, domainId)))
    : [];
  const dnsReady = domains.some(
    (d) =>
      campaignDomainDnsReady(d) &&
      !!d.verifiedAt &&
      d.verifiedAt <= now &&
      !!d.lastCheckedAt &&
      !!d.dmarcCheckedAt &&
      [d.lastCheckedAt, d.dmarcCheckedAt].every(
        (at) => at <= now && now.getTime() - at.getTime() <= 86400000,
      ),
  );
  // Only actual provider success bound to a real admission is positive evidence.
  // Existing approvals, accepted counters, signup age and queued timestamps cannot age a sender.
  const nativeReady = await nativeReputationSchemaReady(db);
  const nativeHistory = nativeReady
    ? nativeReputationRows(teamId, now, domains[0]?.verifiedAt ?? now, domainId)
    : sql`select null::uuid as id, null::timestamptz as accepted_at,
        false as hard, false as complaint, null::timestamptz as watermark where false`;
  const history = firstRow<{ days: string }>(
    await db.execute(sql`
    select count(distinct day)::text as days from (
    select (e.sent_at at time zone 'UTC')::date as day
    from ${schema.emails} e where e.team_id = ${teamId} and e.domain_id = ${domainId ?? null}::uuid and e.ses_message_id is not null
      and e.sent_at >= ${domains[0]?.verifiedAt ?? now}
      and e.sent_at < date_trunc('day', ${now}::timestamptz at time zone 'UTC') at time zone 'UTC'
      and exists (select 1 from ${schema.auditLog} a where a.team_id = ${teamId}
        and a.action = ${ACTION} and a.target = 'graduated:' || e.id::text)
      and not exists (select 1 from ${schema.emailEvents} v inner join ${schema.emails} adverse on adverse.id = v.email_id
        where adverse.team_id = ${teamId} and adverse.domain_id = ${domainId ?? null}::uuid and (v.type='complained' or (v.type='bounced' and v.bounce_type='Permanent')) and v.created_at <= ${now}
          and v.occurred_at >= e.sent_at)
    union
    select (n.accepted_at at time zone 'UTC')::date as day
    from (${nativeHistory}) n
    where ${domainId ?? null}::uuid is not null and n.accepted_at >= ${domains[0]?.verifiedAt ?? now}
      and n.accepted_at < date_trunc('day', ${now}::timestamptz at time zone 'UTC') at time zone 'UTC'
      and exists(select 1 from ${schema.auditLog} a where a.team_id=${teamId} and a.action=${ACTION} and a.target='graduated:'||n.id::text and a.created_at <= n.accepted_at)
      and not exists(select 1 from (${nativeHistory}) adverse
        where (adverse.hard or adverse.complaint) and adverse.watermark >= n.accepted_at)
    ) clean_days
  `),
  );
  const health = await fetchDeliverabilityHealth(db, teamId, { now });
  const quota = teamQuota(
    { ...team, dailySendCeiling: null, betaDailySendCeiling: null },
    true,
    now,
  );
  const planDaily =
    quota.kind === "month"
      ? Math.ceil(quota.included / 30)
      : quota.kind === "day"
        ? quota.limit
        : 0;
  const region = domains[0]?.region ?? "us-east-1";
  const observed = context?.regionalCapacity
    ? ((context.regionalCapacity as Partial<Record<string, CapacityReceipt | null>>)[region] ??
      null)
    : context?.capacityReceipt;
  // External SMTP has no SES resource. Its shared admission capacity is bounded
  // by the actual qualified model envelope, never an invented SES observation.
  const externalEnvelope = external ? judgeEnvelope(now, context) : null;
  const capacity = externalEnvelope
    ? {
        version: 1 as const,
        expiresAt: externalEnvelope.meterExpiresAt,
        globalPerMinute: externalEnvelope.rpm,
        globalDaily: externalEnvelope.rpm * 1440,
        tenantPerMinute: externalEnvelope.tenantRpm,
        judgePerMinute: externalEnvelope.rpm,
      }
    : parseCapacityReceipt(
        observed === undefined
          ? process.env.GRADUATED_SENDING_CAPACITY_JSON
          : JSON.stringify(observed),
        now,
      );
  const dto = graduatedPolicy(
    {
      principalEmail: principal?.email ?? null,
      principalVerified: principal?.verified === true,
      dnsReady,
      suspended: !!team.suspendedAt,
      reviewHeld:
        !principal ||
        (principal.level === "hold" && !principal.clearedAt) ||
        !!(
          team.sendReviewAt &&
          (!team.sendReviewClearedAt || team.sendReviewAt > team.sendReviewClearedAt)
        ),
      plan: team.plan,
      planDaily,
      nominalMonthly: quota.kind === "month" ? quota.included : null,
      cleanSendingDays: Number(history?.days ?? 0),
      operatorCeiling: team.dailySendCeiling,
      sent24h: health.sent,
      hardBounced24h: health.pause.hardBounced,
      complained24h: health.pause.complained,
    },
    capacity,
  );
  // Public effective ceilings cannot promise a plan above the qualified shared
  // frame/token/credit envelope. Missing judge capacity is unknown, not safe.
  let operationalCeiling: number | null = null,
    availableFrames = 0;
  try {
    const j = judgeEnvelope(now, context),
      frame = j.maxInputTokens + j.maxOutputTokens;
    const minute = Math.min(
      dto.effectivePerMinute ?? 0,
      j.rpm,
      j.tenantRpm,
      Math.floor(j.tpm / frame),
    );
    const budget = firstRow<{ held: string }>(
      await db.execute(sql`
    select (coalesce((select sum(reserved_units) from sending_judge_attempts where account_key=${j.accountKey} and state<>'settled'),0)
       +coalesce((select debt_units from sending_judge_account_debt where account_key=${j.accountKey}),0))::text as held`),
    );
    const held = Number(budget?.held ?? NaN);
    if (!Number.isSafeInteger(held) || held < 0) throw new Error("capacity_accounting_unknown");
    availableFrames = Math.floor(
      Math.max(0, j.remainingCreditUnits - held) / j.reservedCreditUnits,
    );
    dto.effectivePerMinute = minute;
    operationalCeiling = Math.min(
      capacity?.globalDaily ?? 0,
      minute * 1440,
      team.dailySendCeiling ?? Number.MAX_SAFE_INTEGER,
    );
    dto.effectiveDaily = Math.min(dto.effectiveDaily, operationalCeiling);
    dto.capacityAvailable = dto.capacityAvailable && minute > 0 && availableFrames > 0;
    if (
      !dto.capacityAvailable &&
      dto.reason !== "sending_suspended" &&
      dto.reason !== "review_required"
    ) {
      dto.reason = "capacity_unavailable";
      dto.nextStep = "retry_later";
    }
  } catch {
    dto.effectivePerMinute = null;
    dto.capacityKnown = false;
    dto.capacityAvailable = false;
    if (dto.reason !== "sending_suspended" && dto.reason !== "review_required") {
      dto.reason = "capacity_unavailable";
      dto.nextStep = "retry_later";
    }
  }
  const usage = firstRow<{ daily: string }>(
    await db.execute(sql`
    select coalesce(sum((data->>'units')::bigint), 0)::text as daily from ${schema.auditLog}
    where team_id = ${teamId} and action = ${ACTION} and created_at > ${now}::timestamptz - interval '24 hours' and created_at <= ${now}
  `),
  );
  dto.dailyUsed = Number(usage?.daily ?? 0);
  let transportHeadroom: number | null = null;
  if (!external && capacity) {
    try {
      transportHeadroom = await sesHeadroom(db, capacity, region, now);
    } catch {
      transportHeadroom = 0;
      dto.capacityKnown = false;
    }
  }
  if (transportHeadroom !== null) availableFrames = Math.min(availableFrames, transportHeadroom);
  dto.capacityAvailable = dto.capacityAvailable && availableFrames > 0;
  if (
    !dto.capacityAvailable &&
    dto.reason !== "sending_suspended" &&
    dto.reason !== "review_required"
  ) {
    dto.reason = "capacity_unavailable";
    dto.nextStep = "retry_later";
  }
  dto.effectiveDaily = budgetBackedDailyCeiling(dto.effectiveDaily, dto.dailyUsed, availableFrames);
  dto.dailyLeft = Math.max(0, dto.effectiveDaily - dto.dailyUsed);
  if (dto.nextDaily !== null)
    dto.nextDaily =
      operationalCeiling === null
        ? null
        : budgetBackedDailyCeiling(
            Math.min(dto.nextDaily, operationalCeiling),
            dto.dailyUsed,
            availableFrames,
          );
  for (const w of dto.newRecipientWindows) {
    const row = firstRow<{ used: string; first: string | null }>(
      await db.execute(sql`
      select count(*)::text as used, min(created_at)::text as first from ${schema.auditLog}
      where team_id=${teamId} and action=${SEEN} and created_at > ${now}::timestamptz-${w.hours}*interval '1 hour' and created_at<=${now}
    `),
    );
    w.used = Number(row?.used ?? 0);
    w.left = Math.max(0, w.limit - w.used);
    w.retryAfterSeconds = row?.first
      ? Math.max(1, Math.ceil((Date.parse(row.first) + w.hours * 3600000 - now.getTime()) / 1000))
      : 0;
  }
  return {
    dto,
    capacity,
    region,
    transportHeadroom,
    planDaily,
    principalEmail: principal?.email ?? null,
    principalId: principal?.id ?? null,
  };
}
/** Must run inside the SAME transaction as email insertion. Global -> tenant
 * advisory locks serialize every replica and every send surface. Reservations
 * are immutable: a reject/ambiguous dispatch does not manufacture clean history
 * or free the original recipient fence. The existing idempotency key owns retry. */
export async function reserveGraduatedSending(
  db: Db,
  input: {
    teamId: string;
    emailId: string;
    from: string;
    recipients: readonly string[];
    campaign: boolean;
    senderProof: GraduatedSenderProof;
  },
  context?: GraduatedContext,
): Promise<TenantReputationDto> {
  const candidate = input.senderProof && senderProofs.get(input.senderProof);
  if (
    candidate?.native &&
    (!context || context !== candidate.context || !originalGraduatedContexts.has(context))
  )
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  await db.execute(sql`select pg_advisory_xact_lock(18475923, 47)`);
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${input.teamId}))`);
  const now = await wallClock(db, context);
  const proof = input.senderProof && senderProofs.get(input.senderProof);
  if (
    !proof ||
    proof.teamId !== input.teamId ||
    proof.from !== normalizeAddress(extractAddrSpec(input.from)) ||
    now.getTime() - proof.at > 30000 ||
    now.getTime() < proof.at
  )
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  const { dto, capacity, region, transportHeadroom, principalEmail, principalId } =
    await loadTenant(db, input.teamId, now, proof.domainId ?? undefined, context, !!proof.external);
  if (proof.external) {
    const [current] = await db
      .select()
      .from(schema.mailboxExternalAccounts)
      .where(
        and(
          eq(schema.mailboxExternalAccounts.mailboxId, proof.external.mailboxId),
          eq(schema.mailboxExternalAccounts.teamId, input.teamId),
        ),
      );
    const [box] = await db
      .select()
      .from(schema.mailboxes)
      .where(
        and(
          eq(schema.mailboxes.id, proof.external.mailboxId),
          eq(schema.mailboxes.teamId, input.teamId),
        ),
      );
    if (
      !current ||
      current.status !== "active" ||
      current.connectionGeneration !== proof.external.generation ||
      !box ||
      box.origin !== "external" ||
      box.status !== "planned" ||
      box.address !== proof.from
    )
      throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  }
  if (principalId !== proof.principalId)
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  if (proof.native) {
    if (context !== proof.context || !context || !originalGraduatedContexts.has(context))
      throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
    await nativeSenderAuthority(
      db,
      {
        teamId: proof.teamId,
        actorUserId: proof.native.actorUserId,
        mailboxId: proof.native.mailboxId,
        from: proof.from,
        domainId: proof.domainId,
        principalId: proof.principalId,
      },
      proof.native,
    );
    judgeEnvelope(await wallClock(db, context), context);
  }
  const [membership] = await db
    .select({ id: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, input.teamId),
        eq(schema.teamMembers.userId, proof.principalId),
      ),
    )
    .limit(1);
  if (!membership) throw new GraduatedAdmissionError("registered_sender_required", dto.plan, 0);
  if (proof.domainId) {
    const [current] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.teamId, input.teamId), eq(schema.domains.id, proof.domainId)));
    if (
      !current ||
      !campaignDomainDnsReady(current) ||
      !current.verifiedAt ||
      current.verifiedAt > now ||
      !current.lastCheckedAt ||
      current.lastCheckedAt > now ||
      now.getTime() - current.lastCheckedAt.getTime() > 86400000 ||
      !current.dmarcCheckedAt ||
      current.dmarcCheckedAt > now ||
      now.getTime() - current.dmarcCheckedAt.getTime() > 86400000
    )
      throw new GraduatedAdmissionError("registered_sender_required", dto.plan, 0);
  }

  if (
    proof.domainId &&
    dto.state !== "domain_verified" &&
    dto.state !== "established" &&
    dto.state !== "suspended" &&
    dto.state !== "unverified"
  )
    throw new GraduatedAdmissionError("registered_sender_required", dto.plan, 0);
  const deny = (
    reason: ConstructorParameters<typeof GraduatedAdmissionError>[0],
    retry = 60,
  ): never => {
    throw new GraduatedAdmissionError(reason, dto.plan, dto.effectiveDaily, retry);
  };
  if (dto.state === "suspended") deny("sending_suspended");
  if (dto.reason === "review_required") deny("review_required");
  if (!capacity || !dto.effectivePerMinute) deny("capacity_unavailable");
  const normalized = input.recipients.map((r) => normalizeAddress(extractAddrSpec(r)));
  if (!normalized.length || normalized.some((r) => !r || !r.includes("@")))
    deny("registered_recipient_required");
  const recipients = [...new Set(normalized)];
  const from = normalizeAddress(extractAddrSpec(input.from));
  if (dto.state === "unverified" && recipients.some((r) => r !== principalEmail?.toLowerCase()))
    deny("registered_recipient_required");
  // Sender proof binds the registered principal to actual authorized From; never spoof signup Gmail.
  if (input.campaign && !dto.campaignEligible) deny("campaign_warming");
  const target = `graduated:${input.emailId}`;
  const fingerprint = digest(
    JSON.stringify([input.teamId, from, recipients.slice().sort(), input.campaign, proof.domainId]),
  );
  const [existing] = await db
    .select({ data: schema.auditLog.data })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.teamId, input.teamId),
        eq(schema.auditLog.action, ACTION),
        eq(schema.auditLog.target, target),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.data?.fingerprint !== fingerprint) deny("review_required");
    return dto;
  }
  const units = recipients.length;
  if (!proof.external && transportHeadroom !== null && units > transportHeadroom)
    deny("capacity_unavailable");
  const usage = firstRow<{ minute: string; daily: string; tenantMinute: string }>(
    await db.execute(sql`
    select coalesce(sum((data->>'units')::bigint) filter(where created_at > ${now}::timestamptz - interval '1 minute'),0)::text as minute,
      coalesce(sum((data->>'units')::bigint),0)::text as daily,
      coalesce(sum((data->>'units')::bigint) filter(where team_id = ${input.teamId} and created_at > ${now}::timestamptz - interval '1 minute'),0)::text as "tenantMinute"
    from ${schema.auditLog} where action = ${ACTION} and created_at > ${now}::timestamptz - interval '24 hours' and created_at <= ${now}
  `),
  );
  if (!usage) deny("capacity_unavailable");
  if (
    Number(usage!.minute) + units > capacity!.globalPerMinute ||
    Number(usage!.tenantMinute) + units > dto.effectivePerMinute!
  )
    deny("minute_limit");
  if (Number(usage!.daily) + units > capacity!.globalDaily) deny("daily_limit", 86400);
  if (dto.dailyUsed + units > dto.effectiveDaily) deny("daily_limit", 86400);
  const hashes = recipients.map(digest);
  const seen = await db
    .select({ target: schema.auditLog.target })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.teamId, input.teamId),
        eq(schema.auditLog.action, SEEN),
        sql`${schema.auditLog.target} in (${sql.join(
          hashes.map((h) => sql`${h}`),
          sql`,`,
        )})`,
      ),
    );
  const known = new Set(seen.map((r) => r.target));
  const fresh = hashes.filter((h) => !known.has(h));
  for (const w of dto.newRecipientWindows)
    if (w.used + fresh.length > w.limit)
      deny("new_recipient_limit", w.retryAfterSeconds || w.hours * 3600);
  // SQL/authority work may outlast the original cached observation. Recheck
  // immediately before persistence without issuing or restamping a receipt.
  const reserveAt = await wallClock(db, context);
  if (!parseCapacityReceipt(JSON.stringify(capacity), reserveAt)) deny("capacity_unavailable");
  try {
    judgeEnvelope(reserveAt, context);
  } catch {
    deny("capacity_unavailable");
  }
  if (fresh.length)
    await db.insert(schema.auditLog).values(
      fresh.map((target) => ({
        teamId: input.teamId,
        actorId: "system",
        action: SEEN,
        target,
        createdAt: now,
        data: { version: 1 },
      })),
    );
  await db.insert(schema.auditLog).values({
    teamId: input.teamId,
    actorId: "system",
    action: ACTION,
    target,
    createdAt: now,
    data: {
      version: 1,
      fingerprint,
      units,
      newRecipients: fresh,
      transport: proof.external ? "external" : "ses",
      region: proof.external ? null : region,
    },
  });
  return dto;
}

declare const proofBrand: unique symbol;
export interface GraduatedSenderProof {
  readonly [proofBrand]: true;
}
/** Server-origin capability for the immutable runtime observation. Only the
 * original context constructor can mark a context; JSON/DTO/structural copies
 * never acquire it, so it cannot become a public dispatch bypass. */
const originalGraduatedContexts = new WeakSet<object>();
export function markOriginalGraduatedContext<T extends object>(context: T): T {
  originalGraduatedContexts.add(context);
  return context;
}
interface NativeSenderAuthority {
  mailboxId: string;
  actorUserId: string;
  actorMembershipId: string;
  principalMembershipId: string;
  principalVerified: boolean;
  grantId: string | null;
}
/** A mailbox selector is not authority. Issue/revalidate only under the original
 * owner/send-grant guard, and bind both actors' exact membership generations.
 * Approval remains B; standing/funding independently follows registered A. */
async function nativeSenderAuthority(
  db: Db,
  input: {
    teamId: string;
    actorUserId: string;
    mailboxId: string;
    from: string;
    domainId: string | null;
    principalId: string;
  },
  expected?: NativeSenderAuthority,
): Promise<NativeSenderAuthority> {
  try {
    return await withMailboxSendAccess(
      db,
      { teamId: input.teamId, userId: input.actorUserId },
      input.mailboxId,
      async (tx, membershipId) => {
        const [box] = await tx
          .select()
          .from(schema.mailboxes)
          .where(
            and(
              eq(schema.mailboxes.id, input.mailboxId),
              eq(schema.mailboxes.teamId, input.teamId),
            ),
          );
        const [principal] = await tx
          .select({ id: schema.teamMembers.id, verified: schema.user.emailVerified })
          .from(schema.teamMembers)
          .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
          .where(
            and(
              eq(schema.teamMembers.teamId, input.teamId),
              eq(schema.teamMembers.userId, input.principalId),
            ),
          )
          .for("share");
        if (!box || box.address !== input.from || box.domainId !== input.domainId || !principal)
          throw new Error("native_sender_required");
        if (input.domainId) {
          const at = await wallClock(tx);
          const [domain] = await tx
            .select()
            .from(schema.domains)
            .where(
              and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, input.teamId)),
            )
            .for("share");
          if (
            !domain ||
            !campaignDomainDnsReady(domain) ||
            input.from.split("@")[1] !== domain.name.toLowerCase() ||
            !domain.verifiedAt ||
            domain.verifiedAt > at ||
            !domain.lastCheckedAt ||
            domain.lastCheckedAt > at ||
            at.getTime() - domain.lastCheckedAt.getTime() > 86400000 ||
            !domain.dmarcCheckedAt ||
            domain.dmarcCheckedAt > at ||
            at.getTime() - domain.dmarcCheckedAt.getTime() > 86400000
          )
            throw new Error("native_sender_required");
        }
        let grantId: string | null = null;
        if (box.ownerUserId !== input.actorUserId || box.ownerMembershipId !== membershipId) {
          const [grant] = await tx
            .select()
            .from(schema.mailboxGrants)
            .where(
              and(
                eq(schema.mailboxGrants.teamId, input.teamId),
                eq(schema.mailboxGrants.mailboxId, input.mailboxId),
                eq(schema.mailboxGrants.userId, input.actorUserId),
                eq(schema.mailboxGrants.membershipId, membershipId),
                isNull(schema.mailboxGrants.revokedAt),
              ),
            )
            .for("share");
          if (!grant || grant.revokedAt || grant.permission !== "send")
            throw new Error("native_sender_required");
          grantId = grant.id;
        }
        const authority = {
          mailboxId: input.mailboxId,
          actorUserId: input.actorUserId,
          actorMembershipId: membershipId,
          principalMembershipId: principal.id,
          principalVerified: principal.verified,
          grantId,
        };
        if (
          expected &&
          (expected.actorMembershipId !== membershipId ||
            expected.principalMembershipId !== principal.id ||
            expected.principalVerified !== principal.verified ||
            expected.grantId !== grantId)
        )
          throw new Error("native_sender_required");
        return authority;
      },
    );
  } catch {
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  }
}
const senderProofs = new WeakMap<
  GraduatedSenderProof,
  {
    teamId: string;
    principalId: string;
    from: string;
    domainId: string | null;
    external?: { mailboxId: string; generation: number };
    native?: NativeSenderAuthority;
    context?: GraduatedContext | undefined;
    at: number;
  }
>();
/** Server constructor: current registered principal, actual membership and
 * current SPF/DKIM domain proof. Caller MUST retain existing mailbox/plan gates.
 * No deserialized boolean or client-created object can represent this proof. */
export async function authorizeGraduatedSender(
  db: Db,
  input: {
    teamId: string;
    actorUserId: string;
    from: string;
    domainId: string | null;
    mailboxId?: string;
  },
  context?: GraduatedContext,
): Promise<GraduatedSenderProof> {
  if (input.mailboxId && (!context || !originalGraduatedContexts.has(context)))
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  const now = await wallClock(db, context);
  const observed = await loadTenant(db, input.teamId, now, input.domainId ?? undefined, context);
  const [member] = await db
    .select({ id: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, input.teamId),
        eq(schema.teamMembers.userId, input.actorUserId),
      ),
    )
    .limit(1);
  const from = normalizeAddress(extractAddrSpec(input.from));
  if (
    !member ||
    !observed.principalId ||
    (!input.mailboxId && observed.principalId !== input.actorUserId) ||
    !from
  )
    throw new GraduatedAdmissionError("registered_sender_required", observed.dto.plan, 0);
  if (input.domainId) {
    const [d] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, input.teamId)));
    if (
      !d ||
      !campaignDomainDnsReady(d) ||
      !d.verifiedAt ||
      d.verifiedAt > now ||
      !d.lastCheckedAt ||
      now.getTime() - d.lastCheckedAt.getTime() > 86400000 ||
      !d.dmarcCheckedAt ||
      now.getTime() - d.dmarcCheckedAt.getTime() > 86400000 ||
      from.split("@")[1] !== d.name.toLowerCase()
    )
      throw new GraduatedAdmissionError("registered_sender_required", observed.dto.plan, 0);
  } else if (
    !process.env.ONBOARDING_EMAIL_FROM ||
    from !== normalizeAddress(extractAddrSpec(process.env.ONBOARDING_EMAIL_FROM))
  )
    throw new GraduatedAdmissionError("registered_sender_required", observed.dto.plan, 0);
  const proof = Object.freeze({}) as GraduatedSenderProof;
  senderProofs.set(proof, {
    teamId: input.teamId,
    principalId: observed.principalId,
    from,
    domainId: input.domainId,
    ...(input.mailboxId
      ? {
          native: await nativeSenderAuthority(db, {
            ...input,
            mailboxId: input.mailboxId,
            from,
            principalId: observed.principalId,
          }),
          context,
        }
      : {}),
    at: now.getTime(),
  });
  return proof;
}
/** Server-only external authority constructor. Original approval/ownership/grant
 * custody remains mandatory in the imported Native queue/dispatch access guards. */
export async function authorizeGraduatedExternalSender(
  db: Db,
  input: { teamId: string; actorUserId: string; from: string; mailboxId: string },
  context?: GraduatedContext,
): Promise<GraduatedSenderProof> {
  if (!context || !originalGraduatedContexts.has(context))
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  const now = await wallClock(db, context);
  const observed = await loadTenant(db, input.teamId, now, undefined, context, true);
  const [member] = await db
    .select()
    .from(schema.teamMembers)
    .where(
      and(
        eq(schema.teamMembers.teamId, input.teamId),
        eq(schema.teamMembers.userId, input.actorUserId),
      ),
    );
  const [box] = await db
    .select()
    .from(schema.mailboxes)
    .where(
      and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, input.teamId)),
    );
  const [account] = await db
    .select()
    .from(schema.mailboxExternalAccounts)
    .where(
      and(
        eq(schema.mailboxExternalAccounts.mailboxId, input.mailboxId),
        eq(schema.mailboxExternalAccounts.teamId, input.teamId),
      ),
    );
  const from = normalizeAddress(extractAddrSpec(input.from));
  if (
    !member ||
    !observed.principalId ||
    !box ||
    box.origin !== "external" ||
    box.status !== "planned" ||
    box.address !== from ||
    !account ||
    account.status !== "active"
  )
    throw new GraduatedAdmissionError("registered_sender_required", observed.dto.plan, 0);
  const proof = Object.freeze({}) as GraduatedSenderProof;
  senderProofs.set(proof, {
    teamId: input.teamId,
    principalId: observed.principalId,
    from,
    domainId: null,
    native: await nativeSenderAuthority(db, {
      ...input,
      from,
      domainId: null,
      principalId: observed.principalId,
    }),
    context,
    external: { mailboxId: input.mailboxId, generation: account.connectionGeneration },
    at: now.getTime(),
  });
  return proof;
}
/** Last synchronous native boundary: no I/O, refresh, caller clock or restamp. */
export function assertGraduatedNativeSenderFresh(
  proof: GraduatedSenderProof,
  context: GraduatedContext,
): void {
  const p = senderProofs.get(proof);
  const now = new Date();
  if (
    !p?.native ||
    p.context !== context ||
    !originalGraduatedContexts.has(context) ||
    now.getTime() < p.at ||
    now.getTime() - p.at > 30000
  )
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  judgeEnvelope(now, context);
}

export async function getGraduatedSenderReputation(
  db: Db,
  proof: GraduatedSenderProof,
  context?: GraduatedContext,
): Promise<TenantReputationDto> {
  const p = senderProofs.get(proof);
  if (
    !p ||
    (p.native && (!context || context !== p.context || !originalGraduatedContexts.has(context)))
  )
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  const now = await wallClock(db, context);
  if (!p || now.getTime() - p.at > 30000 || now.getTime() < p.at)
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  const observed = await loadTenant(
    db,
    p.teamId,
    now,
    p.domainId ?? undefined,
    context,
    !!p.external,
  );
  if (p.native) {
    if (
      context !== p.context ||
      !context ||
      !originalGraduatedContexts.has(context) ||
      observed.principalId !== p.principalId
    )
      throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
    await nativeSenderAuthority(
      db,
      {
        teamId: p.teamId,
        actorUserId: p.native.actorUserId,
        mailboxId: p.native.mailboxId,
        from: p.from,
        domainId: p.domainId,
        principalId: p.principalId,
      },
      p.native,
    );
    if (p.external) {
      const [account] = await db
        .select()
        .from(schema.mailboxExternalAccounts)
        .where(
          and(
            eq(schema.mailboxExternalAccounts.mailboxId, p.external.mailboxId),
            eq(schema.mailboxExternalAccounts.teamId, p.teamId),
          ),
        );
      if (
        !account ||
        account.status !== "active" ||
        account.connectionGeneration !== p.external.generation
      )
        throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
    }
    judgeEnvelope(await wallClock(db, context), context);
  }
  return observed.dto;
}
/** Integer provider accounting units, not dollars or inferred RPM entitlement.
 * Parent supplies a qualified operational envelope and fresh shared meter. */
export interface JudgeOperationalEnvelope {
  accountKey: string;
  /** Only the original server context may select concurrent queue admission. */
  throughputMode?: "bounded-concurrency";
  meterId: string;
  meterAt: string;
  meterExpiresAt: string;
  rpm: number;
  tenantRpm: number;
  tpm: number;
  concurrency: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedCreditUnits: number;
  remainingCreditUnits: number;
}
function judgeEnvelope(now: Date, context?: GraduatedContext): JudgeOperationalEnvelope {
  let v: JudgeOperationalEnvelope;
  try {
    v = context?.judgeEnvelope
      ? { ...context.judgeEnvelope }
      : (JSON.parse(
          process.env.GRADUATED_JUDGE_ENVELOPE_JSON ?? "null",
        ) as JudgeOperationalEnvelope);
  } catch {
    throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
  }
  if (
    !v ||
    (v.throughputMode !== undefined &&
      (!context?.judgeEnvelope || v.throughputMode !== "bounded-concurrency")) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(v.accountKey) ||
    !v.meterId ||
    !Number.isFinite(Date.parse(v.meterAt)) ||
    Date.parse(v.meterAt) > now.getTime() ||
    !Number.isFinite(Date.parse(v.meterExpiresAt)) ||
    Date.parse(v.meterExpiresAt) <= now.getTime() ||
    ![
      v.rpm,
      v.tenantRpm,
      v.tpm,
      v.concurrency,
      v.maxInputTokens,
      v.maxOutputTokens,
      v.reservedCreditUnits,
      v.remainingCreditUnits,
    ].every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
  return v;
}
export interface JudgeAttemptReservation {
  accountKey: string;
  attemptId: string;
  dispatchAllowed: boolean;
  replay: boolean;
  reservedTokens: number;
  reservedCreditUnits: number;
}
/** ROOT DB only: commit reservation BEFORE calling model. Every physical
 * retry/async attempt gets a NEW UUID. Same UUID replay never calls model.
 * Pending/ambiguous retain full budget and concurrency across meter snapshots. */
export async function reserveJudgeAttempt(
  db: Db,
  input: {
    teamId: string;
    emailId: string;
    attemptId: string;
    inputTokenUpperBound: number;
    sourceKind?: "email" | "mailbox";
  },
  context?: GraduatedContext,
): Promise<JudgeAttemptReservation> {
  // An admission queued before an operator pause must not authorize a new model
  // call. Read current trusted runtime policy, without modifying tenant standing.
  const rawPolicy = process.env.SENDING_PROVIDER_POLICY_JSON;
  if (rawPolicy) {
    let policy: unknown;
    try {
      policy = JSON.parse(rawPolicy);
    } catch {
      throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
    }
    if (!policy || typeof policy !== "object" || Array.isArray(policy))
      throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
    const paused = (policy as { paused?: unknown }).paused;
    if (paused !== undefined && typeof paused !== "boolean")
      throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
    if (paused === true) throw new GraduatedAdmissionError("sending_suspended", "unknown", 0);
  }
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(18475923,48)`);
    const now = await wallClock(tx, context),
      v = judgeEnvelope(now, context);
    const [standing] = await tx
      .select({
        held: schema.teams.sendReviewAt,
        cleared: schema.teams.sendReviewClearedAt,
        suspended: schema.teams.suspendedAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (
      !standing ||
      standing.suspended ||
      (standing.held && (!standing.cleared || standing.held > standing.cleared))
    )
      throw new GraduatedAdmissionError("sending_suspended", "unknown", 0);
    const sourceKind = input.sourceKind ?? "email";
    const [email] =
      sourceKind === "email"
        ? await tx
            .select({ id: schema.emails.id, domainId: schema.emails.domainId })
            .from(schema.emails)
            .where(and(eq(schema.emails.id, input.emailId), eq(schema.emails.teamId, input.teamId)))
        : [];
    let native: { id: string; domainId: string | null; origin: string } | undefined;
    if (sourceKind === "mailbox") {
      [native] = await tx
        .select({
          id: schema.mailboxOutbox.id,
          domainId: schema.mailboxes.domainId,
          origin: schema.mailboxes.origin,
        })
        .from(schema.mailboxOutbox)
        .innerJoin(
          schema.mailboxes,
          and(
            eq(schema.mailboxes.id, schema.mailboxOutbox.mailboxId),
            eq(schema.mailboxes.teamId, schema.mailboxOutbox.teamId),
          ),
        )
        .where(
          and(
            eq(schema.mailboxOutbox.id, input.emailId),
            eq(schema.mailboxOutbox.teamId, input.teamId),
            eq(schema.mailboxOutbox.status, "sending"),
          ),
        )
        .limit(1);
    }
    const [admission] = await tx
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.teamId, input.teamId),
          eq(schema.auditLog.action, ACTION),
          eq(schema.auditLog.target, `graduated:${input.emailId}`),
        ),
      )
      .limit(1);
    if (
      (!email && !native) ||
      !admission ||
      !Number.isSafeInteger(input.inputTokenUpperBound) ||
      input.inputTokenUpperBound < 1 ||
      input.inputTokenUpperBound > v.maxInputTokens ||
      !/^[a-f0-9-]{36}$/i.test(input.attemptId)
    )
      throw new GraduatedAdmissionError("review_required", "unknown", 0);
    const fp = digest(
      JSON.stringify([input.teamId, sourceKind, input.emailId, input.inputTokenUpperBound]),
    );
    const old = firstRow<{ fingerprint: string; reserved_tokens: number; reserved_units: number }>(
      await tx.execute(
        sql`select fingerprint,reserved_tokens,reserved_units from sending_judge_attempts where account_key=${v.accountKey} and attempt_id=${input.attemptId}::uuid`,
      ),
    );
    if (old) {
      if (old.fingerprint !== fp) throw new Error("judge_attempt_identity_conflict");
      return {
        accountKey: v.accountKey,
        attemptId: input.attemptId,
        dispatchAllowed: false,
        replay: true,
        reservedTokens: Number(old.reserved_tokens),
        reservedCreditUnits: Number(old.reserved_units),
      };
    }
    if (context?.judgeEnvelope) {
      if (
        (v.throughputMode === "bounded-concurrency"
          ? v.rpm !== 120 || v.tenantRpm !== 120 || v.tpm !== 120245760 || v.concurrency !== 2
          : v.rpm !== 3 || v.tenantRpm > 3 || v.concurrency !== 1) ||
        v.maxInputTokens !== 1000000 ||
        v.maxOutputTokens !== 2048 ||
        v.reservedCreditUnits !== 302457600 ||
        Date.parse(v.meterExpiresAt) - Date.parse(v.meterAt) > 5000
      )
        throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
    }
    let tenantRpm = v.tenantRpm;
    if (context?.judgeEnvelope) {
      const state = await loadTenant(
        tx,
        input.teamId,
        now,
        email?.domainId ?? native?.domainId ?? undefined,
        context,
        native?.origin === "external",
      );
      if (
        !state.principalId ||
        state.dto.state === "suspended" ||
        state.dto.reason === "review_required"
      )
        throw new GraduatedAdmissionError(
          "review_required",
          state.dto.plan,
          state.dto.effectiveDaily,
        );
      tenantRpm = Math.min(
        v.tenantRpm,
        tenantSendingMinuteCeiling(state.dto.state, state.planDaily, state.dto.warmupPercent),
      );
    }
    const tokens = v.maxInputTokens + v.maxOutputTokens; // reserve the FULL qualified frame, never a caller underestimate
    // Shared-account aggregate deltas do not attribute settlement of local usage.
    // Retain known spent debt on unchanged/decreased/increased/reset meters until
    // an independently qualified accounting witness proves local coverage.
    await tx.execute(
      sql`insert into sending_judge_account_debt(account_key,last_meter_id,last_meter_at,last_remaining_units) values(${v.accountKey},${v.meterId},${v.meterAt}::timestamptz,${v.remainingCreditUnits}) on conflict do nothing`,
    );
    const prior = firstRow<{
      last_meter_id: string;
      last_meter_at: Date;
      last_remaining_units: number;
    }>(
      await tx.execute(
        sql`select last_meter_id,last_meter_at,last_remaining_units from sending_judge_account_debt where account_key=${v.accountKey} for update`,
      ),
    );
    if (
      !prior ||
      new Date(prior.last_meter_at) > new Date(v.meterAt) ||
      (prior.last_meter_id === v.meterId &&
        Number(prior.last_remaining_units) !== v.remainingCreditUnits)
    )
      throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
    if (prior.last_meter_id !== v.meterId)
      await tx.execute(
        sql`update sending_judge_account_debt set last_meter_id=${v.meterId},last_meter_at=${v.meterAt}::timestamptz,last_remaining_units=${v.remainingCreditUnits} where account_key=${v.accountKey}`,
      );

    const u = firstRow<{
      calls: string;
      tokens: string;
      tenant: string;
      active: string;
      credits: string;
    }>(
      await tx.execute(sql`
   with recent as(select count(*)::text as calls,coalesce(sum(reserved_tokens),0)::text as tokens,count(*) filter(where team_id=${input.teamId})::text as tenant from sending_judge_attempts where account_key=${v.accountKey} and created_at>${now}::timestamptz-interval '1 minute' and created_at<=${now}),
   active as(select count(*)::text as active,coalesce(sum(reserved_units),0) as credits from sending_judge_attempts where account_key=${v.accountKey} and state<>'settled'),
   metered as(select debt_units as credits from sending_judge_account_debt where account_key=${v.accountKey})
   select recent.*,active.active,(active.credits+metered.credits)::text as credits from recent,active,metered`),
    );
    if (
      !u ||
      (v.throughputMode !== "bounded-concurrency" &&
        (Number(u.calls) + 1 > v.rpm || Number(u.tokens) + tokens > v.tpm)) ||
      Number(u.tenant) + 1 > tenantRpm ||
      Number(u.active) + 1 > v.concurrency ||
      Number(u.credits) + v.reservedCreditUnits > v.remainingCreditUnits
    )
      throw new GraduatedAdmissionError("minute_limit", "unknown", 0, 60);
    await tx.execute(
      sql`insert into sending_judge_attempts(account_key,attempt_id,team_id,message_kind,message_id,email_id,mailbox_outbox_id,fingerprint,reserved_tokens,reserved_units,created_at) values(${v.accountKey},${input.attemptId}::uuid,${input.teamId},${sourceKind},${input.emailId}::uuid,${sourceKind === "email" ? input.emailId : null}::uuid,${sourceKind === "mailbox" ? input.emailId : null}::uuid,${fp},${tokens},${v.reservedCreditUnits},${now})`,
    );
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.judge_attempt_reserved",
      target: input.attemptId,
      createdAt: now,
      data: {
        version: 1,
        accountKey: v.accountKey,
        meterId: v.meterId,
        tokens,
        reservedUnits: v.reservedCreditUnits,
      },
    });
    return {
      accountKey: v.accountKey,
      attemptId: input.attemptId,
      dispatchAllowed: true,
      replay: false,
      reservedTokens: tokens,
      reservedCreditUnits: v.reservedCreditUnits,
    };
  });
}
/** Ordinary API dispatch preflight. Reads current DB authority (email row,
 * tenant standing, registered principal, domain DNS/DMARC) and requires the
 * ORIGINAL durable admission witness already written when the row was accepted.
 * It never creates an admission, financial row or audit: a missing, stale or
 * mismatched witness is a hold, never a new grant. True is returned only after
 * every check passes with an original, fresh server observation. */
export async function verifyGraduatedDispatchAdmission(
  db: Db,
  input: { teamId: string; emailId: string },
  context?: GraduatedContext,
): Promise<boolean> {
  if (!context || typeof context !== "object" || !originalGraduatedContexts.has(context as object))
    return false;
  try {
    const now = await wallClock(db, context);
    judgeEnvelope(now, context);
    const [email] = await db
      .select({
        from: schema.emails.from,
        to: schema.emails.to,
        cc: schema.emails.cc,
        bcc: schema.emails.bcc,
        domainId: schema.emails.domainId,
        topicId: schema.emails.topicId,
      })
      .from(schema.emails)
      .where(and(eq(schema.emails.id, input.emailId), eq(schema.emails.teamId, input.teamId)));
    if (!email) return false;
    const normalized = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])]
      .map((r) => normalizeAddress(extractAddrSpec(r)))
      .filter((r) => !!r && r.includes("@"));
    const recipients = [...new Set(normalized)];
    const from = normalizeAddress(extractAddrSpec(email.from));
    if (!from || !recipients.length) return false;
    // Exactly the accept-time witness identity; a stripped/substituted
    // recipient list can never authorize ADDED recipients or a rewritten audit.
    const fingerprint = digest(
      JSON.stringify([
        input.teamId,
        from,
        recipients.slice().sort(),
        !!email.topicId,
        email.domainId,
      ]),
    );
    const target = `graduated:${input.emailId}`;
    const [witness] = await db
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.teamId, input.teamId),
          eq(schema.auditLog.action, ACTION),
          eq(schema.auditLog.target, target),
        ),
      )
      .limit(1);
    const data = witness?.data;
    if (
      !data ||
      data.version !== 1 ||
      data.fingerprint !== fingerprint ||
      !Number.isSafeInteger(data.units) ||
      data.units !== recipients.length
    )
      return false;
    const [standing] = await db
      .select({
        held: schema.teams.sendReviewAt,
        cleared: schema.teams.sendReviewClearedAt,
        suspended: schema.teams.suspendedAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (
      !standing ||
      standing.suspended ||
      (standing.held && (!standing.cleared || standing.held > standing.cleared))
    )
      return false;
    // Current registered principal: risk-bound identity, else the unique owner.
    const [risk] = await db
      .select({ id: schema.teamSignupRisk.principalUserId })
      .from(schema.teamSignupRisk)
      .where(eq(schema.teamSignupRisk.teamId, input.teamId));
    let actorUserId = risk?.id ?? null;
    if (!actorUserId) {
      const owners = await db
        .select({ id: schema.teamMembers.userId })
        .from(schema.teamMembers)
        .where(
          and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.role, "owner")),
        )
        .limit(2);
      if (owners.length !== 1 || !owners[0]) return false;
      actorUserId = owners[0].id;
    }
    await authorizeGraduatedSender(
      db,
      { teamId: input.teamId, actorUserId, from: email.from, domainId: email.domainId },
      context,
    );
    // Queries and current-authority validation may outlast the immutable origin.
    // Recheck the SAME observation against the DB clock; never restamp it.
    judgeEnvelope(await wallClock(db, context), context);
    return true;
  } catch (error) {
    if (error instanceof GraduatedAdmissionError) return false;
    throw error;
  }
}
/** Call after confirmed outcome. Ambiguous never frees credit/concurrency.
 * A judge rejection changes no tenant suspension/reputation state. */
export async function reconcileJudgeAttempt(
  db: Db,
  input: {
    teamId: string;
    emailId: string;
    accountKey: string;
    attemptId: string;
    outcome: "accepted" | "rejected" | "failed" | "ambiguous";
    actualCreditUnits?: number;
  },
  context?: GraduatedContext,
): Promise<{ settled: boolean; replay: boolean }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(18475923,48)`);
    const now = await wallClock(tx, context);
    const row = firstRow<{
      state: string;
      reserved_units: number;
      actual_units: number | null;
      outcome: string | null;
    }>(
      await tx.execute(
        sql`select state,reserved_units,actual_units,outcome from sending_judge_attempts where account_key=${input.accountKey} and attempt_id=${input.attemptId}::uuid and team_id=${input.teamId} and message_id=${input.emailId}::uuid for update`,
      ),
    );
    if (!row) throw new Error("judge_attempt_scope_mismatch");
    const units = input.actualCreditUnits ?? Number(row.reserved_units);
    if (!Number.isSafeInteger(units) || units < 0 || units > Number(row.reserved_units))
      throw new Error("judge_attempt_invalid_usage");
    if (row.state === "settled") {
      if (row.outcome !== input.outcome || Number(row.actual_units) !== units)
        throw new Error("judge_attempt_reconcile_conflict");
      return { settled: true, replay: true };
    }
    if (input.outcome === "ambiguous") {
      await tx.execute(
        sql`update sending_judge_attempts set state='ambiguous' where account_key=${input.accountKey} and attempt_id=${input.attemptId}::uuid`,
      );
      return { settled: false, replay: row.state === "ambiguous" };
    }
    await tx.execute(
      sql`update sending_judge_attempts set state='settled',outcome=${input.outcome},actual_units=${units},reconciled_at=${now} where account_key=${input.accountKey} and attempt_id=${input.attemptId}::uuid`,
    );
    await tx.execute(
      sql`update sending_judge_account_debt set debt_units=debt_units+${units} where account_key=${input.accountKey}`,
    );
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.judge_attempt_reconciled",
      target: input.attemptId,
      createdAt: now,
      data: { version: 1, outcome: input.outcome, actualCreditUnits: units },
    });
    return { settled: true, replay: false };
  });
}
export async function suspendTenantFromReputation(
  db: Db,
  input: { teamId: string; providerEventId: string; witnessServerSource?: "email" | "mailbox" },
  context?: GraduatedContext,
): Promise<{ suspended: boolean; suspensionId: string | null }> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db,
      now = await wallClock(tx, context);
    const [team] = await tx
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    if (!team) throw new Error("graduated_team_missing");
    if (input.witnessServerSource === "mailbox") {
      const witness = firstRow<{ id: string }>(
        await tx.execute(sql`
      select v.id from mailbox_outbound_events v
      inner join mailbox_outbox o on o.id=v.outbox_id and o.team_id=${input.teamId}::uuid
        and o.attempt_id=v.attempt_id and o.provider_message_id=v.provider_message_id
      inner join mailboxes b on b.id=o.mailbox_id and b.team_id=o.team_id and b.origin='domain'
      where v.id=${input.providerEventId} and v.outcome in ('complaint','hard_bounce')
        and v.occurred_at > ${new Date(0)} and v.occurred_at > ${now}::timestamptz-interval '24 hours'
        and v.occurred_at<=${now} and v.received_at<=${now} and o.status='accepted' and o.accepted_at<=${now}
        and exists(select 1 from mailbox_outbound_outcomes x where x.event_id=v.id and x.recipient_hash=any(o.recipient_hashes))
    `),
      );
      if (!witness) throw new Error("reputation_event_scope_mismatch");
    } else {
      const [event] = await tx
        .select({
          id: schema.emailEvents.id,
          type: schema.emailEvents.type,
          at: schema.emailEvents.occurredAt,
          arrived: schema.emailEvents.createdAt,
          bounce: schema.emailEvents.bounceType,
          provider: schema.emails.sesMessageId,
          eventProvider: schema.emailEvents.snsMessageId,
        })
        .from(schema.emailEvents)
        .innerJoin(schema.emails, eq(schema.emails.id, schema.emailEvents.emailId))
        .where(
          and(
            eq(schema.emails.teamId, input.teamId),
            eq(schema.emailEvents.id, input.providerEventId),
          ),
        );
      if (
        !event ||
        !["bounced", "complained"].includes(event.type) ||
        event.at > now ||
        event.arrived > now ||
        now.getTime() - event.at.getTime() >= 86400000 ||
        (!event.provider && !event.eventProvider) ||
        (event.type === "bounced" && event.bounce !== "Permanent")
      )
        throw new Error("reputation_event_scope_mismatch");
    }
    const [prior] = await tx
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.teamId, input.teamId),
          eq(schema.auditLog.action, "sending.reputation_suspended"),
          eq(schema.auditLog.target, input.providerEventId),
        ),
      )
      .limit(1);
    if (prior)
      return {
        suspended: false,
        suspensionId: typeof prior.data?.suspensionId === "string" ? prior.data.suspensionId : null,
      };
    if (team.suspendedAt) return { suspended: false, suspensionId: null };
    const h = await fetchDeliverabilityHealth(tx, input.teamId, { now });
    if (!reputationCircuitTriggered(h.pause)) return { suspended: false, suspensionId: null };
    const suspensionId = randomUUID();
    await tx
      .update(schema.teams)
      .set({
        suspendedAt: now,
        suspensionReason: "reputation",
        suspensionNote: `graduated-reputation:${suspensionId}`,
      })
      .where(and(eq(schema.teams.id, input.teamId), sql`${schema.teams.suspendedAt} is null`));
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: "system",
      action: "sending.reputation_suspended",
      target: input.providerEventId,
      createdAt: now,
      data: {
        version: 1,
        suspensionId,
        at: now.toISOString(),
        complaintRate: h.sent > 0 ? h.complaintRate : null,
        bounceRate: h.sent > 0 ? h.bounceRate : null,
        denominator: h.sent,
        hardBounced: h.pause.hardBounced,
        complained: h.pause.complained,
      },
    });
    return { suspended: true, suspensionId };
  });
}
/** The caller authenticates an independent operator. This helper CAS-clears
 * ONLY its exact owned episode. Existing holds/contracts/counters stay intact. */
export async function restoreTenantFromReputation(
  db: Db,
  input: { teamId: string; suspensionId: string; operatorId: string; reason: string },
  context?: GraduatedContext,
): Promise<boolean> {
  if (input.reason.trim().length < 15 || input.reason.length > 500)
    throw new Error("reputation_review_reason_required");
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db,
      now = await wallClock(tx, context);
    const [team] = await tx
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    const observed = await loadTenant(tx, input.teamId, now);
    const owners = await tx
      .select({ id: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.role, "owner")))
      .limit(2);
    const [operatorMembership] = await tx
      .select({ id: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(
        and(
          eq(schema.teamMembers.teamId, input.teamId),
          eq(schema.teamMembers.userId, input.operatorId),
        ),
      )
      .limit(1);
    // A missing signup-risk row uses the same actual unique-owner authority as
    // admission; ambiguous/stale risk versus ownership cannot authorize review.
    if (
      !observed.principalId ||
      owners.length !== 1 ||
      owners[0]?.id !== observed.principalId ||
      operatorMembership ||
      observed.principalId === input.operatorId
    )
      throw new Error("reputation_independent_operator_required");
    const health = await fetchDeliverabilityHealth(tx, input.teamId, { now });
    if (reputationCircuitTriggered(health.pause)) return false;
    if (
      !team?.suspendedAt ||
      team.suspensionReason !== "reputation" ||
      team.suspensionNote !== `graduated-reputation:${input.suspensionId}`
    )
      return false;
    const [proof] = await tx
      .select({ data: schema.auditLog.data })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.teamId, input.teamId),
          eq(schema.auditLog.action, "sending.reputation_suspended"),
          sql`${schema.auditLog.data}->>'suspensionId'=${input.suspensionId}`,
        ),
      )
      .limit(1);
    if (proof?.data?.at !== team.suspendedAt.toISOString()) return false;
    await tx
      .update(schema.teams)
      .set({ suspendedAt: null, suspensionReason: null, suspensionNote: null })
      .where(
        and(
          eq(schema.teams.id, input.teamId),
          eq(schema.teams.suspendedAt, team.suspendedAt),
          eq(schema.teams.suspensionNote, `graduated-reputation:${input.suspensionId}`),
        ),
      );
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: `user:${input.operatorId}`,
      action: "sending.reputation_restored",
      target: input.suspensionId,
      createdAt: now,
      data: {
        version: 1,
        reason: input.reason.trim(),
        existingHoldsUnchanged: true,
        noQueueAction: true,
      },
    });
    return true;
  });
}
