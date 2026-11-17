import { randomUUID } from "node:crypto";
import {
  type CapacityRegion,
  createRuntimeCapacityObserver,
  fundedCreditUnits,
  JUDGE_OPERATING_CONCURRENCY,
  JUDGE_OPERATING_MINUTE,
  type RuntimeCapacityReceipt,
} from "./runtime-capacity-observation.js";

const observeCapacity = createRuntimeCapacityObserver();
/** Server-only dimensional ABI. Consumers must join resource buffers against their
 * atomic local commitments; nominal daily flow is never a funded entitlement. */
export type RuntimeGraduatedContext = GraduatedContext & {
  capacityReceipt?: RuntimeCapacityReceipt;
  regionalCapacity?: Readonly<Record<CapacityRegion, RuntimeCapacityReceipt | null>>;
};

import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { getCommandCodeMeter } from "./graduated-commandcode-meter.js";
import {
  type GraduatedContext,
  graduatedSendingEnabled,
  markOriginalGraduatedContext,
} from "./graduated-sending.js";
import { GraduatedAdmissionError } from "./graduated-sending-policy.js";
export async function graduatedSenderPrincipal(db: Db, teamId: string): Promise<string> {
  const [risk] = await db
    .select({ id: schema.teamSignupRisk.principalUserId })
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, teamId));
  if (risk) {
    if (risk.id) return risk.id;
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  }
  const owners = await db
    .select({ id: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "owner")))
    .limit(2);
  if (owners.length !== 1 || !owners[0])
    throw new GraduatedAdmissionError("registered_sender_required", "unknown", 0);
  return owners[0].id;
}

/** Original runtime custody only. This snapshot is never accepted from an HTTP payload.
 * Each caller gets its own immutable, short-lived observation, with no env mutation. */
export async function getGraduatedSendingContext(
  options: {
    config?: { provider: string; model: string; baseUrl: string; apiKey: string | undefined };
    fetch?: typeof fetch;
    purpose?: "admission" | "judge";
  } = {},
): Promise<RuntimeGraduatedContext> {
  if (!graduatedSendingEnabled()) return {};
  const config = options.config ?? {
    provider: process.env.ABUSE_JUDGE ?? "off",
    model: process.env.ABUSE_JUDGE_MODEL ?? "",
    baseUrl: process.env.ABUSE_JUDGE_BASE_URL ?? "",
    apiKey: process.env.ABUSE_JUDGE_API_KEY,
  };
  if (
    !config ||
    config.provider !== "openai" ||
    !["https://api.commandcode.ai/provider/v1", "https://api.commandcode.ai/provider/v1/"].includes(
      config.baseUrl,
    ) ||
    config.model !== "deepseek/deepseek-v4.1-flash"
  )
    throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
  const readMeter = () =>
    getCommandCodeMeter({
      apiKey: config.apiKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  let meter: Awaited<ReturnType<typeof getCommandCodeMeter>>;
  let remainingCreditUnits: number;
  let observation: Awaited<ReturnType<typeof observeCapacity>> | undefined;
  try {
    if (options.purpose === "judge") {
      meter = await readMeter();
      remainingCreditUnits = fundedCreditUnits(meter, Date.now());
    } else {
      // Injected server-only transports cannot read or poison the runtime singleton.
      observation = await (options.fetch || options.config
        ? createRuntimeCapacityObserver()
        : observeCapacity)(readMeter);
      meter = observation.meter;
      remainingCreditUnits = observation.remainingCreditUnits;
    }
  } catch {
    throw new GraduatedAdmissionError("capacity_unavailable", "unknown", 0);
  }
  const judgeEnvelope = Object.freeze({
    accountKey: "commandcode-primary",
    meterId: randomUUID(),
    meterAt: new Date(meter.requestStartedAtMs).toISOString(),
    meterExpiresAt: new Date(meter.requestStartedAtMs + 5000).toISOString(),
    throughputMode: "bounded-concurrency" as const,
    rpm: JUDGE_OPERATING_MINUTE,
    tenantRpm: JUDGE_OPERATING_MINUTE,
    tpm: JUDGE_OPERATING_MINUTE * 1002048,
    concurrency: JUDGE_OPERATING_CONCURRENCY,
    maxInputTokens: 1000000,
    maxOutputTokens: 2048,
    reservedCreditUnits: 302457600,
    remainingCreditUnits,
  });
  return markOriginalGraduatedContext(
    Object.freeze({
      judgeEnvelope,
      ...(observation
        ? {
            ...(observation.regionalCapacity["us-east-1"]
              ? { capacityReceipt: observation.regionalCapacity["us-east-1"] }
              : {}),
            regionalCapacity: observation.regionalCapacity,
          }
        : {}),
    }),
  );
}
