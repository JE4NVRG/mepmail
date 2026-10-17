import { createHash } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, asc, count, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { holdTeamForReview } from "./send-review.js";
import { assessSignupRisk, type SignupRiskSignals } from "./signup-risk-policy.js";
import { collectSignupRiskSignals, signupGenericTeamName } from "./signup-risk-signals.js";

type UserRisk = typeof schema.userSignupRisk.$inferSelect;
type RiskLevel = UserRisk["level"];
const rank: Record<RiskLevel, number> = { good: 0, sandbox: 1, hold: 2 };
const HOUR = 3_600_000;

function lockNames(userId: string, signals: SignupRiskSignals): string[] {
  return [
    `user:${userId}`,
    `domain:${signals.domain}`,
    ...(signals.ipKey ? [`ip:${signals.ipKey}`] : []),
    ...(signals.asn ? [`asn:${signals.asn}`] : []),
  ];
}

/** Read only captured registrations, not team creation or legacy backfills. */
async function currentVelocity(db: Db, signals: SignupRiskSignals, now: Date, increment = 0) {
  const recent = (since: number) =>
    and(
      eq(schema.userSignupRisk.source, "signup"),
      gte(schema.userSignupRisk.capturedAt, new Date(now.getTime() - since)),
      lte(schema.userSignupRisk.capturedAt, now),
    );
  const tally = async (predicate: ReturnType<typeof eq>, window: number) => {
    const [row] = await db
      .select({ n: count() })
      .from(schema.userSignupRisk)
      .where(and(predicate, recent(window)));
    return Number(row?.n ?? 0) + increment;
  };
  return {
    signupsDomain24h: await tally(eq(schema.userSignupRisk.domain, signals.domain), 24 * HOUR),
    signupsIp1h: signals.ipKey
      ? await tally(eq(schema.userSignupRisk.ipKey, signals.ipKey), HOUR)
      : 0,
    signupsAsn1h: signals.asn ? await tally(eq(schema.userSignupRisk.asn, signals.asn), HOUR) : 0,
  };
}

/** Hash only private metadata, then order actual lock IDs to prevent inverted waits. */
async function lock(db: Db, names: string[]): Promise<void> {
  const ids = [
    ...new Set(
      names.map((name) =>
        createHash("sha256").update(`signup-risk:v1\0${name}`).digest().readBigInt64BE().toString(),
      ),
    ),
  ]
    .map(BigInt)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids)
    await db.execute(sql`select pg_advisory_xact_lock(${id.toString()}::bigint)`);
}

async function audit(
  db: Db,
  input: {
    action: string;
    userId: string;
    teamId?: string;
    now: Date;
    data: Record<string, unknown>;
  },
): Promise<void> {
  // Deliberately mandatory, unlike the general best-effort audit helper. A failure
  // rolls the surrounding risk/hold transaction back without printing SQL or data.
  try {
    await db.insert(schema.auditLog).values({
      teamId: input.teamId ?? null,
      actorId: `user:${input.userId}`,
      action: input.action,
      target: input.teamId ? `team:${input.teamId}` : `user:${input.userId}`,
      data: input.data,
      createdAt: input.now,
    });
  } catch {
    throw new Error("signup_risk_audit_unavailable");
  }
}

function observedSignals(value: SignupRiskSignals): SignupRiskSignals {
  // A strict allow-list also prevents an injected lookup from persisting a raw IP.
  return {
    domain: value.domain,
    disposable: value.disposable,
    mx: value.mx,
    domainAgeDays: value.domainAgeDays,
    catchAll: "unknown",
    randomLocal: value.randomLocal,
    ipKey: value.ipKey,
    asn: value.asn,
    signupsIp1h: 0,
    signupsDomain24h: 0,
    signupsAsn1h: 0,
    // These observations come from application events, never DNS/RDAP dependencies.
    verificationSeconds: null,
    genericTeamName: false,
  };
}

/** Capture once. DNS/RDAP/ASN lookups finish before acquiring database locks. */
export async function recordSignupRisk(
  db: Db,
  input: {
    userId: string;
    email: string;
    ip?: string;
    secret: string;
    source?: "signup" | "team_fallback";
    now?: Date;
  },
  deps: { collect?: typeof collectSignupRiskSignals } = {},
): Promise<UserRisk> {
  const [existing] = await db
    .select()
    .from(schema.userSignupRisk)
    .where(eq(schema.userSignupRisk.userId, input.userId));
  if (existing) return existing;
  const source = input.source ?? "signup";
  const now = input.now ?? new Date();
  const signals = observedSignals(
    await (deps.collect ?? collectSignupRiskSignals)({
      email: input.email,
      secret: input.secret,
      now,
      // A fallback is not evidence of the original signup's IP.
      ...(source === "signup" && input.ip ? { ip: input.ip } : {}),
    }),
  );
  if (source === "team_fallback") {
    signals.ipKey = null;
    signals.asn = null;
  }
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lock(tx, lockNames(input.userId, signals));
    const [prior] = await tx
      .select()
      .from(schema.userSignupRisk)
      .where(eq(schema.userSignupRisk.userId, input.userId));
    if (prior) return prior;
    const [principal] = await tx
      .select({ verified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.id, input.userId));
    if (!principal) throw new Error("signup_risk_principal_missing");
    Object.assign(signals, await currentVelocity(tx, signals, now, source === "signup" ? 1 : 0));
    const assessment = assessSignupRisk(signals);
    const [created] = await tx
      .insert(schema.userSignupRisk)
      .values({
        userId: input.userId,
        capturedAt: now,
        source,
        domain: signals.domain,
        ipKey: signals.ipKey,
        asn: signals.asn,
        signals,
        ...assessment,
        verifiedAt: source === "signup" && principal.verified ? now : null,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new Error("signup_risk_capture_conflict");
    await audit(tx, {
      action: "auth.signup_risk_recorded",
      userId: input.userId,
      now,
      data: {
        source,
        level: assessment.level,
        policyVersion: assessment.policyVersion,
        reasons: assessment.reasons,
        hasIpSignal: signals.ipKey !== null,
        hasAsnSignal: signals.asn !== null,
        verifiedObserved: created.verifiedAt !== null,
      },
    });
    return created;
  });
}

/** Called only after actual verification; updated_at is never a substitute. */
export async function markSignupEmailVerified(
  db: Db,
  input: { userId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await lock(tx, [`user:${input.userId}`]);
    const [principal] = await tx
      .select({ verified: schema.user.emailVerified, createdAt: schema.user.createdAt })
      .from(schema.user)
      .where(eq(schema.user.id, input.userId));
    if (!principal?.verified) return;
    const [profile] = await tx
      .select()
      .from(schema.userSignupRisk)
      .where(eq(schema.userSignupRisk.userId, input.userId));
    if (!profile || profile.verifiedAt) return;
    const elapsed = (now.getTime() - principal.createdAt.getTime()) / 1000;
    // An already-verified social capture has verifiedAt set, and a legacy fallback
    // has no observed email journey. Neither may fabricate a zero-second signal.
    const verificationSeconds =
      profile.source === "signup" && Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null;
    const signals = { ...profile.signals, verificationSeconds };
    const assessment = assessSignupRisk(signals);
    const level = rank[assessment.level] > rank[profile.level] ? assessment.level : profile.level;
    const reasons = [...new Set([...profile.reasons, ...assessment.reasons])];
    const changed = await tx
      .update(schema.userSignupRisk)
      .set({ verifiedAt: now, signals, level, reasons, policyVersion: assessment.policyVersion })
      .where(
        and(
          eq(schema.userSignupRisk.userId, input.userId),
          isNull(schema.userSignupRisk.verifiedAt),
        ),
      )
      .returning({ id: schema.userSignupRisk.userId });
    if (!changed.length) return;
    // A team may already exist before its principal confirms email. Project the
    // observed callback immediately, so it cannot keep an obsolete good profile
    // until its first full key. Operator-cleared teams retain their override.
    const teams = await tx
      .select()
      .from(schema.teamSignupRisk)
      .where(
        and(
          eq(schema.teamSignupRisk.principalUserId, input.userId),
          isNull(schema.teamSignupRisk.clearedAt),
        ),
      )
      .for("update");
    for (const team of teams) {
      const teamSignals = { ...team.signals, verificationSeconds };
      const teamAssessment = assessSignupRisk(teamSignals);
      const previous = rank[level] > rank[team.level] ? level : team.level;
      const teamLevel =
        rank[teamAssessment.level] > rank[previous] ? teamAssessment.level : previous;
      const teamReasons = [...new Set([...team.reasons, ...reasons, ...teamAssessment.reasons])];
      await tx
        .update(schema.teamSignupRisk)
        .set({
          signals: teamSignals,
          level: teamLevel,
          reasons: teamReasons,
          policyVersion: teamAssessment.policyVersion,
        })
        .where(
          and(
            eq(schema.teamSignupRisk.teamId, team.teamId),
            isNull(schema.teamSignupRisk.clearedAt),
          ),
        );
      if (teamLevel === "hold")
        await holdTeamForReview(tx, {
          teamId: team.teamId,
          reason: "new_sender",
          note: "Signup risk requires operator review.",
          now,
        });
      if (teamLevel !== team.level)
        await audit(tx, {
          action: "team.signup_risk_escalated",
          userId: input.userId,
          teamId: team.teamId,
          now,
          data: {
            from: team.level,
            to: teamLevel,
            reasons: teamReasons,
            policyVersion: teamAssessment.policyVersion,
            verificationObserved: true,
          },
        });
    }
    await audit(tx, {
      action: "auth.signup_risk_verified",
      userId: input.userId,
      now,
      data: { verifiedAt: now.toISOString(), verificationSeconds, level },
    });
  });
}

/** Must run inside the same transaction that creates the team and its owner. */
export async function enrollTeamSignupRisk(
  tx: Db,
  input: { teamId: string; userId: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await lock(tx, [`user:${input.userId}`]);
  const [prior] = await tx
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, input.teamId));
  if (prior) return;
  const [profile] = await tx
    .select()
    .from(schema.userSignupRisk)
    .where(eq(schema.userSignupRisk.userId, input.userId));
  if (!profile) throw new Error("signup_risk_profile_required");
  const [team] = await tx
    .select({ createdAt: schema.teams.createdAt, name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!team) throw new Error("signup_risk_team_missing");
  const [heldOwner] = await tx
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .innerJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teams.id))
    .where(
      and(
        eq(schema.teamMembers.userId, input.userId),
        eq(schema.teamMembers.role, "owner"),
        ne(schema.teams.id, input.teamId),
        or(isNotNull(schema.teams.sendReviewAt), isNotNull(schema.teams.suspendedAt)),
      ),
    )
    .limit(1);
  const signals = { ...profile.signals, genericTeamName: signupGenericTeamName(team.name) };
  const assessment = assessSignupRisk(signals);
  const level = heldOwner
    ? "hold"
    : rank[assessment.level] > rank[profile.level]
      ? assessment.level
      : profile.level;
  const reasons = [
    ...new Set([
      ...profile.reasons,
      ...assessment.reasons,
      ...(heldOwner ? ["existing_owner_hold"] : []),
    ]),
  ];
  const inserted = await tx
    .insert(schema.teamSignupRisk)
    .values({
      teamId: input.teamId,
      principalUserId: input.userId,
      level,
      reasons,
      signals,
      policyVersion: assessment.policyVersion,
      createdAt: team.createdAt,
    })
    .onConflictDoNothing()
    .returning({ id: schema.teamSignupRisk.teamId });
  if (!inserted.length) return;
  if (heldOwner && profile.level !== "hold")
    await tx
      .update(schema.userSignupRisk)
      .set({ level: "hold", reasons })
      .where(eq(schema.userSignupRisk.userId, input.userId));
  if (level === "hold")
    await holdTeamForReview(tx, {
      teamId: input.teamId,
      reason: "new_sender",
      note: "Signup risk requires operator review.",
      now,
    });
  await audit(tx, {
    action: "team.signup_risk_enrolled",
    userId: input.userId,
    teamId: input.teamId,
    now,
    data: {
      level,
      reasons,
      policyVersion: assessment.policyVersion,
      inheritedOwnerHold: Boolean(heldOwner),
    },
  });
}

/** Server-only details. Public procedures must return only the restriction kind. */
export async function getTeamSignupRisk(db: Db, teamId: string) {
  const [row] = await db
    .select({
      level: schema.teamSignupRisk.level,
      reasons: schema.teamSignupRisk.reasons,
      signals: schema.teamSignupRisk.signals,
      policyVersion: schema.teamSignupRisk.policyVersion,
      principalEmail: schema.user.email,
      principalVerified: schema.user.emailVerified,
      clearedAt: schema.teamSignupRisk.clearedAt,
    })
    .from(schema.teamSignupRisk)
    .leftJoin(schema.user, eq(schema.user.id, schema.teamSignupRisk.principalUserId))
    .where(eq(schema.teamSignupRisk.teamId, teamId));
  if (!row) return null;
  return {
    ...row,
    level: row.principalEmail ? row.level : ("hold" as const),
    reasons: row.principalEmail ? row.reasons : [...new Set([...row.reasons, "principal_missing"])],
    principalVerified: row.principalVerified === true,
    // Preserve the historical override in storage, but it cannot authorize an
    // orphaned principal. A new owner never silently replaces that identity.
    clearedAt: row.principalEmail ? row.clearedAt : null,
  };
}

/** A first full key can escalate a captured assessment; never lowers risk or releases mail. */
export async function refreshSignupRiskAfterFullKey(
  db: Db,
  input: { teamId: string; now?: Date },
): Promise<void> {
  await db.transaction((transaction) =>
    refreshSignupRiskForKey(transaction as unknown as Db, { ...input, issued: true }),
  );
}

/** Must share the issuance transaction: a refused attempt still commits its
 * monotonic risk assessment, but no API-key secret has been generated. */
export async function prepareSignupRiskForApiKey(
  tx: Db,
  input: { teamId: string; permission: "full_access" | "sending_access"; now?: Date },
): Promise<void> {
  await refreshSignupRiskForKey(tx, { ...input, issued: false });
}

async function refreshSignupRiskForKey(
  tx: Db,
  input: {
    teamId: string;
    permission?: "full_access" | "sending_access";
    issued: boolean;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const [identity] = await tx
    .select({
      userId: schema.teamSignupRisk.principalUserId,
      signals: schema.teamSignupRisk.signals,
    })
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, input.teamId));
  if (!identity?.userId) return;
  const userId = identity.userId;
  // Match capture's complete lock set and ordering, so a concurrent signup
  // cannot hide a newly formed burst from the first-key assessment.
  await lock(tx, lockNames(userId, identity.signals));
  const [risk] = await tx
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, input.teamId))
    .for("update");
  if (!risk || risk.clearedAt || risk.principalUserId !== userId) return;
  const [profile] = await tx
    .select()
    .from(schema.userSignupRisk)
    .where(eq(schema.userSignupRisk.userId, userId));
  const [team] = await tx
    .select({ createdAt: schema.teams.createdAt, name: schema.teams.name })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!team) return;
  const [key] = await tx
    .select({ createdAt: schema.apiKeys.createdAt })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.teamId, input.teamId),
        eq(schema.apiKeys.permission, "full_access"),
        gte(schema.apiKeys.createdAt, team.createdAt),
        lte(schema.apiKeys.createdAt, now),
      ),
    )
    .orderBy(asc(schema.apiKeys.createdAt))
    .limit(1);
  if (input.issued && !key) return;
  const elapsed = (key?.createdAt ?? now).getTime() - team.createdAt.getTime();
  const rapidFullKey =
    (key !== undefined || input.permission === "full_access") && elapsed >= 0 && elapsed <= 180_000;
  const signals: SignupRiskSignals = {
    ...risk.signals,
    ...(await currentVelocity(tx, risk.signals, now)),
    rapidFullKey: risk.signals.rapidFullKey === true || rapidFullKey,
    genericTeamName: signupGenericTeamName(team.name),
    verificationSeconds: profile?.signals.verificationSeconds ?? null,
  };
  const assessment = assessSignupRisk(signals);
  const priorLevel = profile && rank[profile.level] > rank[risk.level] ? profile.level : risk.level;
  const level = rank[assessment.level] > rank[priorLevel] ? assessment.level : priorLevel;
  const reasons = [
    ...new Set([...risk.reasons, ...(profile?.reasons ?? []), ...assessment.reasons]),
  ];
  const changed =
    JSON.stringify(signals) !== JSON.stringify(risk.signals) ||
    risk.policyVersion !== assessment.policyVersion ||
    level !== risk.level ||
    reasons.length !== risk.reasons.length;
  if (!changed) return;
  await tx
    .update(schema.teamSignupRisk)
    .set({ level, reasons, signals, policyVersion: assessment.policyVersion })
    .where(
      and(eq(schema.teamSignupRisk.teamId, input.teamId), isNull(schema.teamSignupRisk.clearedAt)),
    );
  if (profile) {
    const userSignals = { ...profile.signals, ...signals };
    const userAssessment = assessSignupRisk(userSignals);
    const userLevel = rank[level] > rank[userAssessment.level] ? level : userAssessment.level;
    await tx
      .update(schema.userSignupRisk)
      .set({
        level: rank[userLevel] > rank[profile.level] ? userLevel : profile.level,
        reasons: [...new Set([...profile.reasons, ...reasons, ...userAssessment.reasons])],
        signals: userSignals,
        policyVersion: assessment.policyVersion,
      })
      .where(eq(schema.userSignupRisk.userId, userId));
  }
  if (level === "hold")
    await holdTeamForReview(tx, {
      teamId: input.teamId,
      reason: "new_sender",
      note: "Signup risk requires operator review.",
      now,
    });
  await audit(tx, {
    action: "team.signup_risk_escalated",
    userId,
    teamId: input.teamId,
    now,
    data: {
      from: risk.level,
      to: level,
      reasons,
      policyVersion: assessment.policyVersion,
      rapidFullKey: signals.rapidFullKey,
      ...(input.issued ? {} : { keyIssuanceAttempt: true }),
    },
  });
}
