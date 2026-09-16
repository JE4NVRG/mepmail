import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { type AbuseJudge, JudgeError, type JudgeVerdict } from "@millionsend/core";
import { JUDGE_MAX_TOKENS, judgePrompt, throwIfAbort, verdictFromText } from "./shared.js";

/** The client surface the adapter needs; a test passes a fake. */
export interface BedrockConverseClient {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ output?: { message?: { content?: { text?: string }[] } } }>;
}

const THROTTLED = new Set([
  "ThrottlingException",
  "ServiceQuotaExceededException",
  "TooManyRequestsException",
]);
const NO_CREDENTIALS = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "CredentialsProviderError",
  "ExpiredTokenException",
  "InvalidSignatureException",
]);

/**
 * Bedrock Converse with the AWS credential chain SES already uses: explicit
 * keys when the env carries them, else the SDK's default providers.
 */
export function createBedrockJudge(opts: {
  model: string;
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  client?: BedrockConverseClient;
}): AbuseJudge {
  const client: BedrockConverseClient =
    opts.client ??
    new BedrockRuntimeClient({
      region: opts.region,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    });
  return {
    provider: "bedrock",
    model: opts.model,
    async judge(block, { signal }): Promise<JudgeVerdict> {
      const { system, user } = judgePrompt(block);
      let response: Awaited<ReturnType<BedrockConverseClient["send"]>>;
      try {
        response = await client.send(
          new ConverseCommand({
            modelId: opts.model,
            system: [{ text: system }],
            messages: [{ role: "user", content: [{ text: user }] }],
            inferenceConfig: { temperature: 0, maxTokens: JUDGE_MAX_TOKENS },
          }),
          { abortSignal: signal },
        );
      } catch (err) {
        throwIfAbort(err);
        const name = (err as { name?: string }).name ?? "";
        if (THROTTLED.has(name)) throw new JudgeError("throttled", name, { cause: err });
        if (NO_CREDENTIALS.has(name)) throw new JudgeError("no_credentials", name, { cause: err });
        throw new JudgeError("upstream", name || "bedrock call failed", { cause: err });
      }
      const text = (response.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
      return verdictFromText(text);
    },
  };
}
