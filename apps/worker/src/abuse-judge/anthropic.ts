import { type AbuseJudge, JudgeError, type JudgeVerdict } from "@millionsend/core";
import {
  classForStatus,
  type FetchLike,
  JUDGE_MAX_TOKENS,
  judgePrompt,
  throwIfAbort,
  verdictFromText,
} from "./shared.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/** The Messages API; 529 (overloaded) is a throttle like 429. */
export function createAnthropicJudge(opts: {
  model: string;
  apiKey: string | undefined;
  baseUrl?: string;
  fetch?: FetchLike;
}): AbuseJudge {
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${(opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, "")}/v1/messages`;
  return {
    provider: "anthropic",
    model: opts.model,
    async judge(block, { signal }): Promise<JudgeVerdict> {
      if (!opts.apiKey) throw new JudgeError("no_credentials", "ABUSE_JUDGE_API_KEY is unset");
      const { system, user } = judgePrompt(block);
      let res: Response;
      try {
        res = await fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: opts.model,
            system,
            messages: [{ role: "user", content: user }],
            max_tokens: JUDGE_MAX_TOKENS,
            temperature: 0,
          }),
          signal,
        });
      } catch (err) {
        throwIfAbort(err);
        throw new JudgeError("upstream", "judge request failed", { cause: err });
      }
      if (!res.ok) throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`);
      const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const text = (json.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      return verdictFromText(text);
    },
  };
}
