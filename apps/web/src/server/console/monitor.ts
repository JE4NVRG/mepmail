import { abuseJudgeConfig } from "@millionsend/config";

/** What the console says about the judge: off, or the provider and model the env names. */
export type JudgeStatus =
  | { on: false }
  | {
      on: true;
      provider: "bedrock" | "openai" | "anthropic";
      model: string;
      /** Bedrock's region; null for the hosted providers. */
      region: string | null;
      /** The OpenAI-compatible endpoint; null for the others. */
      baseUrl: string | null;
    };

export function judgeStatus(): JudgeStatus {
  const config = abuseJudgeConfig();
  if (!config) return { on: false };
  return {
    on: true,
    provider: config.provider,
    model: config.model,
    region: config.provider === "bedrock" ? config.region : null,
    baseUrl: config.provider === "openai" ? config.baseUrl : null,
  };
}
