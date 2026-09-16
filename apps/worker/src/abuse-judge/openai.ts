import { type AbuseJudge, JudgeError, type JudgeVerdict } from "@millionsend/core";
import {
  classForStatus,
  type FetchLike,
  JUDGE_MAX_TOKENS,
  JUDGE_REASONING_MAX_TOKENS,
  judgePrompt,
  throwIfAbort,
  verdictFromText,
} from "./shared.js";

/**
 * Chat Completions against any OpenAI-compatible endpoint. Some models reject
 * a parameter the request carries (gpt-5 models refuse `temperature` and
 * want `max_completion_tokens`): a 400 that names the parameter is retried
 * without it, or with its replacement, and the adapter remembers the shape
 * so later calls skip the round trip. A gpt-5 model reasons at "minimal",
 * the effort the probe scored best at, with the probe's output cap.
 */
export function createOpenAiJudge(opts: {
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  fetch?: FetchLike;
}): AbuseJudge {
  const fetcher: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const reasoning = /^gpt-5/i.test(opts.model);
  const omitted = new Set<string>();
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
        ...(reasoning
          ? { reasoning_effort: "minimal", max_completion_tokens: JUDGE_REASONING_MAX_TOKENS }
          : { temperature: 0, max_tokens: JUDGE_MAX_TOKENS }),
      };
      for (const key of omitted) {
        if (key === "max_tokens") body.max_completion_tokens = JUDGE_MAX_TOKENS;
        delete body[key];
      }
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
        if (res.status === 400 && attempt < 3) {
          const param = unsupportedParam(detail);
          if (param && param in body && !omitted.has(param)) {
            omitted.add(param);
            if (param === "max_tokens") body.max_completion_tokens = JUDGE_MAX_TOKENS;
            delete body[param];
            continue;
          }
        }
        throw new JudgeError(classForStatus(res.status), `judge answered ${res.status}`);
      }
    },
  };
}

const RETRYABLE_PARAMS = /'(temperature|response_format|max_tokens|reasoning_effort)'/;

/** The parameter a 400 body names as unsupported, from its `param` field or its message. */
function unsupportedParam(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { error?: { param?: string; message?: string } };
    if (parsed.error?.param) return parsed.error.param;
    return parsed.error?.message?.match(RETRYABLE_PARAMS)?.[1] ?? null;
  } catch {
    return detail.match(RETRYABLE_PARAMS)?.[1] ?? null;
  }
}
