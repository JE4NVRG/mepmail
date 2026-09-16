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

/**
 * The Messages API; 529 (overloaded) is a throttle like 429. Newer Claude
 * models refuse sampling parameters, so a 400 naming `temperature` is
 * retried without it and the adapter remembers.
 */
export function createAnthropicJudge(opts: {
  model: string;
  apiKey: string | undefined;
  baseUrl?: string;
  fetch?: FetchLike;
}): AbuseJudge {
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${(opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/$/, "")}/v1/messages`;
  let withTemperature = true;
  return {
    provider: "anthropic",
    model: opts.model,
    async judge(block, { signal }): Promise<JudgeVerdict> {
      if (!opts.apiKey) throw new JudgeError("no_credentials", "ABUSE_JUDGE_API_KEY is unset");
      const { system, user } = judgePrompt(block);
      let res: Response;
      for (let attempt = 0; ; attempt += 1) {
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
              ...(withTemperature ? { temperature: 0 } : {}),
            }),
            signal,
          });
        } catch (err) {
          throwIfAbort(err);
          throw new JudgeError("upstream", "judge request failed", { cause: err });
        }
        if (res.ok) break;
        const detail = await res.text().catch(() => "");
        if (res.status === 400 && withTemperature && attempt === 0 && /temperature/.test(detail)) {
          withTemperature = false;
          continue;
        }
        throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`);
      }
      const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const text = (json.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
      return verdictFromText(text);
    },
  };
}
