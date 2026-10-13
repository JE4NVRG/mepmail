import {
  DeleteSuppressedDestinationCommand,
  GetSuppressedDestinationCommand,
  SESv2Client,
} from "@aws-sdk/client-sesv2";

/** Structural subset of SESv2Client so callers inject a fake in tests. */
export interface SesSuppressionClient {
  send(
    command: GetSuppressedDestinationCommand | DeleteSuppressedDestinationCommand,
  ): Promise<unknown>;
}

export function createSesSuppressionClient(options: {
  region: string;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
}): SesSuppressionClient {
  const { region, accessKeyId, secretAccessKey } = options;
  return new SESv2Client({
    region,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

/**
 * What became of an address on SES's account-level suppression list:
 * removed (it was there for a bounce), not_listed, kept_complaint (a complaint is never
 * lifted from here), denied (the credentials lack ses:GetSuppressedDestination or
 * ses:DeleteSuppressedDestination) or unavailable (SES did not answer).
 */
export type SesSuppressionRemoval =
  | "removed"
  | "not_listed"
  | "kept_complaint"
  | "denied"
  | "unavailable";

function errorName(error: unknown): string {
  return (error as { name?: string } | null)?.name ?? "";
}

/**
 * Lifts a BOUNCE suppression of one address in one region. The list is the whole SES
 * account's, shared by every team, so only a bounce is lifted, never a complaint.
 */
export async function removeSesBounceSuppression(
  client: SesSuppressionClient,
  address: string,
): Promise<SesSuppressionRemoval> {
  let reason: string | undefined;
  try {
    const found = (await client.send(
      new GetSuppressedDestinationCommand({ EmailAddress: address }),
    )) as { SuppressedDestination?: { Reason?: string } };
    reason = found.SuppressedDestination?.Reason;
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFoundException") return "not_listed";
    if (name === "AccessDeniedException") return "denied";
    return "unavailable";
  }
  if (reason !== "BOUNCE") return reason === "COMPLAINT" ? "kept_complaint" : "not_listed";
  try {
    await client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: address }));
    return "removed";
  } catch (error) {
    const name = errorName(error);
    if (name === "NotFoundException") return "not_listed";
    if (name === "AccessDeniedException") return "denied";
    return "unavailable";
  }
}
