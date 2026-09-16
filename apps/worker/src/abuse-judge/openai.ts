import { type AbuseJudge, JudgeError, type JudgeVerdict } from "@millionsend/core";
import {
  classForStatus,
  type FetchLike,
  JUDGE_MAX_TOKENS,
  judgePrompt,
  throwIfAbort,
  verdictFromText,
} from "./shared.js";

/**
 * Chat Completions against any OpenAI-compatible endpoint. Some models reject
 * a parameter the request carries (gpt-5-nano refuses `temperature`; newer
 * models want `max_completion_tokens`): a 400 that names the parameter is
 * retried once without it, or with its replacement.
 */
export function createOpenAiJudge(opts: {
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  fetch?: FetchLike;
}): AbuseJudge {
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    provider: "openai",
    model: opts.model,
    async judge(block, { signal }): Promise<JudgeVerdict> {
      if (!opts.apiKey) throw new JudgeError("no_credentials", "ABUSE_JUDGE_API_KEY is unset");
      const { system, user } = judgePrompt(block);
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: JUDGE_MAX_TOKENS,
      };
      for (let attempt = 0; ; attempt += 1) {
        let res: Response;
        try {
          res = await fetcher(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
            body: JSON.stringify(body),
            signal,
          });
        } catch (err) {
          throwIfAbort(err);
          throw new JudgeError("upstream", "judge request failed", { cause: err });
        }
        if (res.ok) {
          const json = (await res.json()) as {
            choices?: { message?: { content?: string | { text?: string }[] } }[];
          };
          const content = json.choices?.[0]?.message?.content;
          const text = Array.isArray(content)
            ? content.map((c) => c.text ?? "").join("")
            : (content ?? "");
          return verdictFromText(text);
        }
        const detail = await res.text().catch(() => "");
        if (res.status === 400 && attempt < 2) {
          const param = unsupportedParam(detail);
          if (param === "temperature" || param === "response_format") {
            delete body[param];
            continue;
          }
          if (param === "max_tokens") {
            delete body.max_tokens;
            body.max_completion_tokens = JUDGE_MAX_TOKENS;
            continue;
          }
        }
        throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`);
      }
    },
  };
}

/** The parameter a 400 body names as unsupported, from its `param` field or its message. */
function unsupportedParam(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { error?: { param?: string; message?: string } };
    if (parsed.error?.param) return parsed.error.param;
    const named = parsed.error?.message?.match(/'(temperature|response_format|max_tokens)'/);
    return named?.[1] ?? null;
  } catch {
    return detail.match(/'(temperature|response_format|max_tokens)'/)?.[1] ?? null;
  }
}
