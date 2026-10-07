import { env, isCloudDeployment, servedRegions } from "@millionsend/config";
import {
  createSesAccountClient,
  getAccountOverview,
  type SesAccountClient,
} from "@millionsend/ses";
import { awsCredentialsConfigured } from "./system-mail";

/** How long a region's pause answer is reused. */
const PAUSE_PROBE_TTL_MS = 60_000;

/**
 * SES's own pause per region (EnforcementStatus SHUTDOWN or sending off), at
 * most one GetAccount a minute per region: the dashboard strip and the auth
 * screens read it on every render, and the non-send SES API is throttled at
 * one request per second. Only a region's first probe is awaited; an expired
 * answer is served at once while the probe refreshes it. A failed probe keeps
 * the last answer; without credentials nothing is probed.
 */
export function createSesPauseProbe(accountClient: (region: string) => SesAccountClient) {
  const probes = new Map<string, { at: number; value: Promise<boolean> }>();
  return (region: string): Promise<boolean> => {
    const cached = probes.get(region);
    if (cached && Date.now() - cached.at < PAUSE_PROBE_TTL_MS) return cached.value;
    const value = awsCredentialsConfigured()
      ? getAccountOverview(accountClient(region)).then(
          (overview) => overview.enforcementStatus === "SHUTDOWN" || !overview.sendingEnabled,
          () => cached?.value ?? false,
        )
      : Promise.resolve(false);
    probes.set(region, { at: Date.now(), value });
    return cached ? cached.value : value;
  };
}

const defaultProbe = createSesPauseProbe((region) =>
  createSesAccountClient({
    region,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  }),
);

/** Whether SES has paused any region this cloud deployment serves. */
export async function cloudSendingPaused(probe = defaultProbe): Promise<boolean> {
  if (!isCloudDeployment()) return false;
  const answers = await Promise.all(servedRegions().map((region) => probe(region)));
  return answers.some(Boolean);
}

/**
 * Whether account mail (the verification link above all) is running late:
 * SES is paused and no SMTP fallback carries platform mail meanwhile. The
 * auth screens then point people at a social sign-in, which needs no link.
 */
export async function accountMailDelayed(probe = defaultProbe): Promise<boolean> {
  if (env.SMTP_FALLBACK_URL) return false;
  return cloudSendingPaused(probe);
}
