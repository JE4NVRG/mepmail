import { type Db, schema } from "@millionsend/db";
import { and, eq, ne } from "drizzle-orm";

const MIN_KEY_LENGTH = 5;

const GENERIC_KEYS = new Set([
  "admin",
  "agency",
  "company",
  "default",
  "email",
  "hello",
  "mailer",
  "marketing",
  "newsletter",
  "office",
  "personal",
  "portal",
  "project",
  "service",
  "studio",
  "support",
  "system",
  "testing",
  "workspace",
]);

const TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.br",
  "net.br",
  "org.br",
  "edu.br",
  "gov.br",
  "com.au",
  "net.au",
  "org.au",
  "com.pt",
  "com.fr",
  "com.es",
  "co.za",
  "com.mx",
  "com.ar",
  "com.co",
]);

/** Normalizes a team name or label to lowercase ASCII letters and digits. */
export function phishingBrandKey(value: string): string | null {
  const key = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (key.length < MIN_KEY_LENGTH || GENERIC_KEYS.has(key)) return null;
  return key;
}

/** Extracts the organizational label key from a hostname (e.g. `mail.acmehealth.com` -> `acmehealth`). */
export function domainBrandKey(hostname: string): string | null {
  const labels = hostname.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const tailTwo = labels.slice(-2).join(".");
  const labelIndex =
    labels.length >= 3 && TWO_PART_SUFFIXES.has(tailTwo) ? labels.length - 3 : labels.length - 2;
  return phishingBrandKey(labels[labelIndex] ?? "");
}

export interface PhishingRecidivismMatch {
  source: "team_name" | "suspended_domain";
  matchedTeamId: string;
  key: string;
}

async function listSuspendedPhishingSignals(db: Db, excludeTeamId: string) {
  const suspendedTeams = await db
    .select({ id: schema.teams.id, name: schema.teams.name })
    .from(schema.teams)
    .where(and(eq(schema.teams.suspensionReason, "phishing"), ne(schema.teams.id, excludeTeamId)));
  if (!suspendedTeams.length) return { teams: [], domains: [] };
  const domains = await db
    .select({ teamId: schema.domains.teamId, name: schema.domains.name })
    .from(schema.domains)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.domains.teamId))
    .where(and(eq(schema.teams.suspensionReason, "phishing"), ne(schema.teams.id, excludeTeamId)));
  return { teams: suspendedTeams, domains };
}

/** Checks if a new team name matches a team or domain previously suspended for phishing. */
export async function findPhishingRecidivismTeamMatch(
  db: Db,
  input: { teamId: string; teamName: string },
): Promise<PhishingRecidivismMatch | null> {
  const key = phishingBrandKey(input.teamName);
  if (!key) return null;
  const { teams, domains } = await listSuspendedPhishingSignals(db, input.teamId);
  for (const prior of teams) {
    if (phishingBrandKey(prior.name) === key) {
      return { source: "team_name", matchedTeamId: prior.id, key };
    }
  }
  for (const domain of domains) {
    if (domainBrandKey(domain.name) === key) {
      return { source: "suspended_domain", matchedTeamId: domain.teamId, key };
    }
  }
  return null;
}

/** Checks if a newly added domain matches a team or domain previously suspended for phishing. */
export async function findPhishingRecidivismDomainMatch(
  db: Db,
  input: { teamId: string; domain: string },
): Promise<PhishingRecidivismMatch | null> {
  const normalizedDomain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const key = domainBrandKey(normalizedDomain);
  const { teams, domains } = await listSuspendedPhishingSignals(db, input.teamId);
  for (const domain of domains) {
    const priorNormalized = domain.name.trim().toLowerCase().replace(/\.$/, "");
    if (priorNormalized === normalizedDomain) {
      return {
        source: "suspended_domain",
        matchedTeamId: domain.teamId,
        key: key ?? normalizedDomain,
      };
    }
  }
  const candidateKeys = new Set<string>();
  if (key) candidateKeys.add(key);
  const labels = normalizedDomain.split(".").filter(Boolean);
  const tailTwo = labels.slice(-2).join(".");
  const orgIndex =
    labels.length >= 3 && TWO_PART_SUFFIXES.has(tailTwo) ? labels.length - 3 : labels.length - 2;
  for (let i = 0; i < orgIndex; i++) {
    const subKey = phishingBrandKey(labels[i] ?? "");
    if (subKey) candidateKeys.add(subKey);
  }
  if (candidateKeys.size === 0) return null;
  for (const domain of domains) {
    const priorKey = domainBrandKey(domain.name);
    if (priorKey && candidateKeys.has(priorKey)) {
      return { source: "suspended_domain", matchedTeamId: domain.teamId, key: priorKey };
    }
  }
  for (const prior of teams) {
    const priorKey = phishingBrandKey(prior.name);
    if (priorKey && candidateKeys.has(priorKey)) {
      return { source: "team_name", matchedTeamId: prior.id, key: priorKey };
    }
  }
  return null;
}
