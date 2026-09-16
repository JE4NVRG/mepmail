import type { AbuseJudgeConfig } from "@millionsend/config";
import type { AbuseJudge } from "@millionsend/core";
import { createAnthropicJudge } from "./anthropic.js";
import { createBedrockJudge } from "./bedrock.js";
import { createOpenAiJudge } from "./openai.js";

/** The judge the env names, or null when the monitor is off. */
export function createAbuseJudge(
  config: AbuseJudgeConfig | null,
  aws: { accessKeyId?: string | undefined; secretAccessKey?: string | undefined } = {},
): AbuseJudge | null {
  if (!config) return null;
  switch (config.provider) {
    case "bedrock":
      return createBedrockJudge({
        model: config.model,
        region: config.region,
        credentials:
          aws.accessKeyId && aws.secretAccessKey
            ? { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey }
            : undefined,
      });
    case "openai":
      return createOpenAiJudge({
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      });
    case "anthropic":
      return createAnthropicJudge({ model: config.model, apiKey: config.apiKey });
  }
}
