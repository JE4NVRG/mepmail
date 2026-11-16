import { JudgeError } from "@millionsend/core";

export const MAX_JUDGE_REQUEST_UTF8_BYTES = 65_536;
export const MAX_COMMANDCODE_OUTPUT_TOKENS = 2_048;
/** Conservative catalog INPUT reservation, not an exact tokenizer or entitlement. */
export const COMMANDCODE_INPUT_TOKEN_UPPER_BOUND = 1_000_000;
export interface JudgeProviderUsage {
  inputTokens: number;
  outputTokens: number;
}
export function serializeBoundedJudgeRequest(request: unknown): string {
  const body = JSON.stringify(request);
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_JUDGE_REQUEST_UTF8_BYTES)
    throw new JudgeError("parse_error", "judge request exceeds the complete frame bound");
  return body;
}
/** Only authenticated provider response fields, never actor/request/UI estimates. */
export function readJudgeProviderUsage(value: unknown): JudgeProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return valid(usage.prompt_tokens) && valid(usage.completion_tokens)
    ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
    : null;
}
