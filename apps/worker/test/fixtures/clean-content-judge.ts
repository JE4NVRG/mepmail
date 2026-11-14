import type { AbuseJudge, JudgeVerdict } from "@millionsend/core";
/** Explicit synthetic approval only. Never imported by production callers. */
export const syntheticCleanVerdict: JudgeVerdict = {
  score: 2,
  verdict: "clean",
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};
export const syntheticCleanContentJudge: AbuseJudge = {
  provider: "openai",
  model: "deepseek/deepseek-v4.1-flash",
  judge: async () => ({ ...syntheticCleanVerdict }),
};
