import {
  ABUSE_JUDGE_RUBRIC,
  JudgeError,
  type JudgeVerdict,
  judgeUserMessage,
  parseJudgeOutput,
} from "@millionsend/core";

/** The prompt every adapter sends: the rubric as the system turn, the fenced block as the user turn. */
export function judgePrompt(block: string): { system: string; user: string } {
  return { system: ABUSE_JUDGE_RUBRIC, user: judgeUserMessage(block) };
}

/** The verdict from the model's text, as a judge error when it does not parse. */
export function verdictFromText(text: string): JudgeVerdict {
  return parseJudgeOutput(text);
}

/** An aborted call is a timeout however the runtime names it; any other error is the caller's to class. */
export function throwIfAbort(err: unknown): void {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    throw new JudgeError("timeout", "judge call timed out", { cause: err });
  }
}

/** HTTP status → error class, shared by the two hosted providers. */
export function classForStatus(status: number): "throttled" | "no_credentials" | "upstream" {
  if (status === 429 || status === 529) return "throttled";
  if (status === 401 || status === 403) return "no_credentials";
  return "upstream";
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const JUDGE_MAX_TOKENS = 300;
/** A reasoning model spends part of its cap thinking; the probe ran gpt-5-nano at this. */
export const JUDGE_REASONING_MAX_TOKENS = 600;
