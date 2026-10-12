import type { AbuseJudgeConfig } from "@millionsend/config";
import {
  ABUSE_JUDGE_QUESTIONS,
  type AbuseJudge,
  composeJudgeVerdict,
  JudgeError,
  type JudgeVerdict,
  judgeState,
  judgeStatusClass,
} from "@millionsend/core";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function throwIfAbort(err: unknown): void {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") {
    throw new JudgeError("timeout", "judge call timed out", { cause: err });
  }
}

/** TypeSafe System One: typed questions in, composed verdict out. No chat, no JSON parse of prose. */
export function createTypesafeJudge(
  opts: Pick<AbuseJudgeConfig, "model" | "baseUrl" | "apiKey"> & { fetch?: FetchLike },
): AbuseJudge {
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/systemone`;
  return {
    provider: "typesafe",
    model: opts.model,
    async judge(block, { signal }): Promise<JudgeVerdict> {
      if (!opts.apiKey) throw new JudgeError("no_credentials", "ABUSE_JUDGE_API_KEY is unset");
      let res: Response;
      try {
        res = await fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            state: judgeState(block),
            model: opts.model,
            questions: ABUSE_JUDGE_QUESTIONS,
          }),
          signal,
        });
      } catch (err) {
        throwIfAbort(err);
        throw new JudgeError("upstream", "judge request failed", { cause: err });
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new JudgeError(judgeStatusClass(res.status, detail), `judge answered ${res.status}`);
      }
      let json: { answers?: unknown; model?: unknown };
      try {
        json = (await res.json()) as { answers?: unknown; model?: unknown };
      } catch (err) {
        throw new JudgeError("parse_error", "judge body was not JSON", { cause: err });
      }
      return composeJudgeVerdict(json.answers);
    },
  };
}
