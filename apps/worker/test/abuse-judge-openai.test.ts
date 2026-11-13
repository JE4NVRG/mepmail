import { ABUSE_JUDGE_POLICY, ABUSE_JUDGE_QUESTIONS, JudgeError } from "@millionsend/core";
import { describe, expect, it, vi } from "vitest";
import { createAbuseJudge } from "../src/abuse-judge/index.js";
import {
  createOpenAiJudge,
  foldOpenAiAnswers,
  OPENAI_JUDGE_SYSTEM_PROMPT,
  parseJudgeContent,
} from "../src/abuse-judge/openai.js";

const reply = (content: string, status = 200) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
const signal = () => new AbortController().signal;

describe("OpenAI-compatible judge", () => {
  it("posts the policy and every question, the email fenced as data, and scores the JSON answer", async () => {
    let posted: { url: string; body: Record<string, unknown>; auth: string | null } | undefined;
    const judge = createOpenAiJudge({
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://api.commandcode.ai/provider/v1/",
      apiKey: "k",
      fetch: async (url, init) => {
        posted = {
          url,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          auth: new Headers(init?.headers).get("authorization"),
        };
        return reply(
          "```json\n" +
            JSON.stringify({
              is_abuse: 0.97,
              impersonation: 0.9,
              off_domain_lure: 0.8,
              harvests_secrets: true,
              payment_redirect: 0,
              category: "phishing_credentials",
              language: "other",
            }) +
            "\n```",
        );
      },
    });
    const verdict = await judge.judge("Team name: Dental\nFrom: Assurances <a@x.example>", {
      signal: signal(),
    });
    expect(verdict).toMatchObject({
      score: 97,
      verdict: "abuse",
      categories: ["phishing_credentials"],
      reasons: ["impersonation", "off_domain_lure", "harvests_secrets"],
      language: "other",
    });
    expect(posted?.url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    expect(posted?.auth).toBe("Bearer k");
    expect(posted?.body).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const messages = posted?.body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toContain(ABUSE_JUDGE_POLICY);
    for (const key of Object.keys(ABUSE_JUDGE_QUESTIONS)) {
      expect(OPENAI_JUDGE_SYSTEM_PROMPT).toContain(`"${key}"`);
    }
    expect(messages[1]?.content).toMatch(/^<email>\n[\s\S]*\n<\/email>$/);
  });

  it.each([
    [
      "canonical base",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai/provider/v1",
      true,
    ],
    [
      "trailing slash",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai/provider/v1/",
      true,
    ],
    [
      "default HTTPS port",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai:443/provider/v1",
      true,
    ],
    [
      "default port and slash",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai:443/provider/v1/",
      true,
    ],
    ["other provider", "deepseek/deepseek-v4.1-flash", "https://api.openai.com/v1", false],
    [
      "lookalike host",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai.example.test/provider/v1",
      false,
    ],
    ["wrong path", "deepseek/deepseek-v4.1-flash", "https://api.commandcode.ai/v1", false],
    ["path case", "deepseek/deepseek-v4.1-flash", "https://api.commandcode.ai/Provider/v1", false],
    ["HTTP base", "deepseek/deepseek-v4.1-flash", "http://api.commandcode.ai/provider/v1", false],
    [
      "other port",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai:444/provider/v1",
      false,
    ],
    [
      "query string",
      "deepseek/deepseek-v4.1-flash",
      "https://api.commandcode.ai/provider/v1?x=1",
      false,
    ],
    ["fragment", "deepseek/deepseek-v4.1-flash", "https://api.commandcode.ai/provider/v1#x", false],
    [
      "userinfo",
      "deepseek/deepseek-v4.1-flash",
      "https://user@api.commandcode.ai/provider/v1",
      false,
    ],
    ["unrelated model", "unrelated-model", "https://api.commandcode.ai/provider/v1", false],
    [
      "model suffix",
      "deepseek/deepseek-v4.1-flash-extra",
      "https://api.commandcode.ai/provider/v1",
      false,
    ],
    ["invalid base", "deepseek/deepseek-v4.1-flash", "not a URL", false],
  ])(
    "preserves the factory request contract for %s",
    async (_name, model, baseUrl, nonThinking) => {
      const requestSignal = signal();
      const block = "Team name: Contract fixture\nSubject: Informational notice";
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          reply(JSON.stringify({ is_abuse: 0.02, category: "clean", language: "en" })),
        );
      try {
        const judge = createAbuseJudge({
          provider: "openai",
          model: String(model),
          baseUrl: String(baseUrl),
          apiKey: "contract-fixture",
          timeoutMs: 20_000,
        });
        if (!judge) throw new Error("factory did not create a judge");
        await expect(judge.judge(block, { signal: requestSignal })).resolves.toMatchObject({
          score: 2,
          verdict: "clean",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] ?? [];
        expect(url).toBe(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`);
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBe(requestSignal);
        expect(new Headers(init?.headers)).toEqual(
          new Headers({
            "content-type": "application/json",
            authorization: "Bearer contract-fixture",
          }),
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: OPENAI_JUDGE_SYSTEM_PROMPT },
            { role: "user", content: `<email>\n${block}\n</email>` },
          ],
          ...(nonThinking ? { reasoning_effort: "off" } : {}),
        });
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("keeps an invalid base failure at request time rather than throwing at construction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("invalid URL"));
    try {
      const judge = createAbuseJudge({
        provider: "openai",
        model: "deepseek/deepseek-v4.1-flash",
        baseUrl: "not a URL",
        apiKey: "contract-fixture",
        timeoutMs: 20_000,
      });
      if (!judge) throw new Error("factory did not create a judge");
      await expect(judge.judge("fixture", { signal: signal() })).rejects.toMatchObject({
        class: "upstream",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reads clean mail as clean and tolerates TypeSafe-shaped values", () => {
    const answers = foldOpenAiAnswers({
      is_abuse: { noul: 0.02 },
      impersonation: 1.4,
      category: { choice: "clean" },
      language: "en",
      unknown_key: 1,
    });
    expect(answers).toEqual({
      is_abuse: { type: "noul", noul: 0.02 },
      impersonation: { type: "noul", noul: 1 },
      category: { type: "choice", choice: "clean" },
      language: { type: "choice", choice: "en" },
    });
  });

  it("maps failures to the judge's error classes", async () => {
    const failing = (status: number) =>
      createOpenAiJudge({
        model: "m",
        baseUrl: "https://x",
        apiKey: "k",
        fetch: async () => reply("{}", status),
      });
    await expect(failing(429).judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "throttled",
    });
    await expect(failing(401).judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "no_credentials",
    });
    await expect(failing(500).judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "upstream",
    });
    // A gateway out of credits answers 400 with the reason in the body: that is the operator's key.
    const broke = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x",
      apiKey: "k",
      fetch: async () =>
        reply(
          '{"error":{"message":"You have insufficient credits to make this request.","type":"invalid_request_error"}}',
          400,
        ),
    });
    await expect(broke.judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "no_credentials",
    });
    await expect(failing(400).judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "upstream",
    });
    await expect(failing(402).judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "no_credentials",
    });
    const keyless = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x",
      fetch: async () => reply("{}"),
    });
    await expect(keyless.judge("b", { signal: signal() })).rejects.toBeInstanceOf(JudgeError);
    const prose = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x",
      apiKey: "k",
      fetch: async () => reply("I think it is fine."),
    });
    await expect(prose.judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "parse_error",
    });
    const noAbuseKey = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x",
      apiKey: "k",
      fetch: async () => reply('{"category":"clean"}'),
    });
    await expect(noAbuseKey.judge("b", { signal: signal() })).rejects.toMatchObject({
      class: "parse_error",
    });
    expect(() => parseJudgeContent("[1,2]")).toThrow(JudgeError);
  });

  it("is what the factory builds for ABUSE_JUDGE=openai", () => {
    const judge = createAbuseJudge({
      provider: "openai",
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      apiKey: "k",
      timeoutMs: 20_000,
    });
    expect(judge).toMatchObject({ provider: "openai", model: "deepseek/deepseek-v4.1-flash" });
  });
});
