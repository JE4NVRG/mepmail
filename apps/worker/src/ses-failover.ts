const REGION_NAME = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface SesFailover {
  region: string;
  domains: ReadonlySet<string>;
}

/**
 * The operator's failover SES region and the domains allowed to use it:
 * SES_FAILOVER_REGION=eu-west-1, SES_FAILOVER_DOMAINS=mepmail.dev,... Each
 * listed domain must already be a verified identity in that region (with the
 * default configuration set there); the worker sends a listed domain's
 * transactional mail from it only while SES has paused the domain's own
 * region. Both unset: no failover. One without the other, a malformed region
 * or a malformed domain fails startup, so a typo never silently disables it.
 */
export function parseSesFailover(
  region: string | undefined,
  domains: string | undefined,
): SesFailover | null {
  const r = region?.trim() ?? "";
  const list = (domains ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  if (!r && list.length === 0) return null;
  if (!REGION_NAME.test(r) || list.length === 0 || list.some((d) => !DOMAIN_NAME.test(d)))
    throw new Error("ses_failover_invalid");
  return Object.freeze({ region: r, domains: new Set(list) });
}
