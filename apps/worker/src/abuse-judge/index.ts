import { randomUUID } from "node:crypto";
import type { AbuseJudgeConfig } from "@millionsend/config";
import {
  type AbuseJudge,
  getGraduatedSendingContext,
  graduatedSendingEnabled,
  JudgeError,
  reconcileJudgeAttempt,
  reserveJudgeAttempt,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { getCommandCodeMeter } from "./commandcode-meter.js";
import { createOpenAiJudge } from "./openai.js";
import { createTypesafeJudge } from "./typesafe.js";

const configs = new WeakMap<AbuseJudge, AbuseJudgeConfig>();
export function createAbuseJudge(config: AbuseJudgeConfig | null): AbuseJudge | null {
  if (!config) return null;
  const judge =
    config.provider === "openai" ? createOpenAiJudge(config) : createTypesafeJudge(config);
  const guarded: AbuseJudge = {
    ...judge,
    judge(block, opts) {
      if (graduatedSendingEnabled()) throw new JudgeError("throttled", "scoped admission required");
      return judge.judge(block, opts);
    },
  };
  configs.set(guarded, config);
  return guarded;
}
/** Scope is closure-owned, never request JSON or mutable process state. */
export function judgeForEmail(
  judge: AbuseJudge,
  db: Db,
  teamId: string,
  emailId: string,
  sourceKind: "email" | "mailbox" = "email",
): AbuseJudge {
  if (!graduatedSendingEnabled()) return judge;
  const config = configs.get(judge);
  return {
    provider: judge.provider,
    model: judge.model,
    async judge(block, opts) {
      if (
        !config ||
        config.provider !== "openai" ||
        ![
          "https://api.commandcode.ai/provider/v1",
          "https://api.commandcode.ai/provider/v1/",
        ].includes(config.baseUrl ?? "") ||
        config.model !== "deepseek/deepseek-v4.1-flash"
      )
        throw new JudgeError("throttled", "qualified judge unavailable");
      const attemptId = randomUUID();
      let reservation: Awaited<ReturnType<typeof reserveJudgeAttempt>> | undefined;
      let actualCreditUnits: number | undefined;
      let confirmed = false;
      const scoped = createOpenAiJudge({
        ...config,
        beforeFetch: async () => {
          const context = await getGraduatedSendingContext({ config, purpose: "judge" });
          reservation = await reserveJudgeAttempt(
            db,
            { teamId, emailId, attemptId, inputTokenUpperBound: 1000000, sourceKind },
            context,
          );
          if (!reservation.dispatchAllowed)
            throw new JudgeError("throttled", "attempt replay refused");
        },
      });
      const settle = async (outcome: "accepted" | "rejected" | "ambiguous") => {
        if (reservation)
          await reconcileJudgeAttempt(db, {
            teamId,
            emailId,
            accountKey: reservation.accountKey,
            attemptId,
            outcome,
            ...(actualCreditUnits === undefined ? {} : { actualCreditUnits }),
          });
      };
      try {
        const result = await scoped.judge(block, {
          ...opts,
          onUsage: async (usage) => {
            confirmed = true;
            if (usage)
              actualCreditUnits = Math.ceil(usage.inputTokens * 300 + usage.outputTokens * 1200);
            await opts?.onUsage?.(usage);
          },
        });
        await settle(result.verdict === "clean" ? "accepted" : "rejected");
        return result;
      } catch (error) {
        await settle(confirmed ? "rejected" : "ambiguous");
        throw error;
      }
    },
  };
}
