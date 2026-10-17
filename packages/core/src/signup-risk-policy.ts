/** Private anti-abuse signals. No payment decision, customer content or raw IP. */
export interface SignupRiskSignals {
  domain: string;
  disposable: boolean;
  mx: "present" | "null" | "absent" | "unknown";
  domainAgeDays: number | null;
  catchAll: "unknown";
  randomLocal: boolean;
  ipKey: string | null;
  asn: number | null;
  signupsIp1h: number;
  signupsDomain24h: number;
  signupsAsn1h: number;
  rapidFullKey?: boolean;
  /** Positive elapsed time from principal creation to a real email-verification callback. */
  verificationSeconds?: number | null;
  /** Weak template-name evidence only. The original team name is never stored here. */
  genericTeamName?: boolean;
}

export interface SignupRiskAssessment {
  level: "good" | "sandbox" | "hold";
  reasons: string[];
  policyVersion: 2;
}

/** These are evidence-combination thresholds, never an IP/ASN blocklist. */
export const SIGNUP_RISK_THRESHOLDS = {
  // Observed registration ages include 13–27 days: seven days missed those
  // combinations. Thirty days is a conservative observation window, not a
  // claim of predictive accuracy; domain age alone still never restricts.
  youngDomainDays: 30,
  signupsIp1h: 3,
  signupsDomain24h: 3,
  signupsAsn1h: 12,
  rapidVerificationSeconds: 15,
} as const;

const reaches = (value: number, threshold: number): boolean =>
  Number.isInteger(value) && value >= threshold;

/** Pure classification; authorization and the verified sandbox principal are separate. */
export function assessSignupRisk(s: SignupRiskSignals): SignupRiskAssessment {
  const reasons: string[] = [];
  const result = (level: SignupRiskAssessment["level"]): SignupRiskAssessment => ({
    level,
    reasons,
    policyVersion: 2,
  });
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(s.domain)) {
    reasons.push("invalid_email_domain");
    return result("sandbox");
  }
  const ageKnown =
    s.domainAgeDays !== null && Number.isFinite(s.domainAgeDays) && s.domainAgeDays >= 0;
  const young =
    ageKnown &&
    s.domainAgeDays !== null &&
    s.domainAgeDays < SIGNUP_RISK_THRESHOLDS.youngDomainDays;
  const ipBurst = !!s.ipKey && reaches(s.signupsIp1h, SIGNUP_RISK_THRESHOLDS.signupsIp1h);
  const domainBurst = reaches(s.signupsDomain24h, SIGNUP_RISK_THRESHOLDS.signupsDomain24h);
  const asnBurst =
    s.asn !== null &&
    Number.isInteger(s.asn) &&
    s.asn > 0 &&
    s.asn <= 4_294_967_295 &&
    reaches(s.signupsAsn1h, SIGNUP_RISK_THRESHOLDS.signupsAsn1h);
  const burst = ipBurst || domainBurst || asnBurst;
  // Zero may be an already-verified/social signup, not a measured email journey.
  const rapidVerification =
    typeof s.verificationSeconds === "number" &&
    Number.isFinite(s.verificationSeconds) &&
    s.verificationSeconds > 0 &&
    s.verificationSeconds <= SIGNUP_RISK_THRESHOLDS.rapidVerificationSeconds;
  if (s.disposable) reasons.push("disposable_domain");
  if (s.randomLocal) reasons.push("random_local");
  if (young) reasons.push("recently_registered_domain");
  if (!ageKnown) reasons.push("domain_age_unknown");
  if (s.mx !== "present") reasons.push(`mx_${s.mx}`);
  if (ipBurst) reasons.push("signup_ip_burst");
  if (domainBurst) reasons.push("signup_domain_burst");
  if (asnBurst) reasons.push("signup_asn_burst");
  if (s.rapidFullKey) reasons.push("rapid_full_key");
  if (rapidVerification) reasons.push("rapid_email_verification");
  if (s.genericTeamName) reasons.push("generic_team_name");

  // No single weak signal, payment status or provider ASN can create a hold.
  if (
    (young && s.randomLocal && (burst || s.rapidFullKey === true)) ||
    (s.disposable && s.randomLocal && burst)
  )
    return result("hold");
  if (s.randomLocal && burst) {
    reasons.push(ageKnown ? "identity_burst" : "unknown_age_identity_burst");
    return result("sandbox");
  }
  if (
    (!ageKnown || s.mx !== "present") &&
    s.randomLocal &&
    (s.genericTeamName === true || rapidVerification || s.rapidFullKey === true)
  ) {
    reasons.push("corroborated_unknown_identity");
    return result("sandbox");
  }
  // An unavailable lookup is not exonerating evidence either. Keep a wave-like
  // identity in the recipient sandbox when a rapid full key corroborates it;
  // missing age/MX can never turn this combination into an operator hold.
  if (
    s.rapidFullKey === true &&
    ((s.randomLocal &&
      (!ageKnown || s.mx !== "present" || rapidVerification || s.genericTeamName === true)) ||
      (rapidVerification && (!ageKnown || s.mx !== "present" || s.genericTeamName === true)))
  ) {
    reasons.push("corroborated_rapid_identity");
    return result("sandbox");
  }
  if (
    s.disposable ||
    (young && (s.randomLocal || burst || s.rapidFullKey === true)) ||
    ((s.mx === "null" || s.mx === "absent") && s.randomLocal)
  )
    return result("sandbox");
  return result("good");
}
