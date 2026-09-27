import { abuseJudgeConfig } from "@millionsend/config";

/** What the console says about the judge: off, or the TypeSafe model the env names. */
export type JudgeStatus =
  | { on: false }
  | {
      on: true;
      provider: "typesafe";
      model: string;
      region: string | null;
      baseUrl: string | null;
    };

export function judgeStatus(): JudgeStatus {
  const config = abuseJudgeConfig();
  if (!config) return { on: false };
  return {
    on: true,
    provider: config.provider,
    model: config.model,
    region: null,
    baseUrl: config.baseUrl,
  };
}
