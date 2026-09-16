import type { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ABUSE_JUDGE_RUBRIC, JudgeError } from "@millionsend/core";
import { describe, expect, it } from "vitest";
import { createAnthropicJudge } from "../src/abuse-judge/anthropic.js";
import { type BedrockConverseClient, createBedrockJudge } from "../src/abuse-judge/bedrock.js";
import { createAbuseJudge } from "../src/abuse-judge/index.js";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";

const BLOCK = "Team name: Acme\nSubject: hi";
const signal = new AbortController().signal;

async function errorClass(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "none";
  } catch (err) {
    return err instanceof JudgeError ? err.class : `other:${String(err)}`;
  }
}

function fetchStub(
  handler: (body: Record<string, unknown>, attempt: number) => { status: number; body: unknown },
) {
  const calls: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    const res = handler(body, calls.length);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

describe("OpenAI-compatible adapter", () => {
  const ok = (text: string) => ({
    status: 200,
    body: { choices: [{ message: { content: text } }] },
  });

  it("sends the rubric and the fenced block, and reads a fenced answer", async () => {
    const { fetch, calls } = fetchStub(() => ok('```json\n{"score": 90, "verdict": "abuse"}\n```'));
    const judge = createOpenAiJudge({
      model: "m",
      baseUrl: "https://llm.example.com/v1/",
      apiKey: "k",
      fetch,
    });
    expect(await judge.judge(BLOCK, { signal })).toMatchObject({ score: 90, verdict: "abuse" });
    expect(calls[0]).toMatchObject({
      model: "m",
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
    const messages = calls[0]?.messages as { role: string; content: string }[];
    expect(messages[0]).toEqual({ role: "system", content: ABUSE_JUDGE_RUBRIC });
    expect(messages[1]?.content).toContain("<<<EMAIL\nTeam name: Acme");
  });

  it("retries once without a parameter the model rejects, and swaps max_tokens", async () => {
    const { fetch, calls } = fetchStub((body) => {
      if ("temperature" in body) {
        return {
          status: 400,
          body: {
            error: {
              message: "Unsupported parameter: 'temperature' is not supported with this model.",
              param: "temperature",
            },
          },
        };
      }
      if ("max_tokens" in body) {
        return {
          status: 400,
          body: {
            error: {
              message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
            },
          },
        };
      }
      return ok('{"score": 5}');
    });
    const judge = createOpenAiJudge({
      model: "gpt-5-nano",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      fetch,
    });
    expect((await judge.judge(BLOCK, { signal })).score).toBe(5);
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toHaveProperty("temperature");
    expect(calls[2]).toMatchObject({ max_completion_tokens: 300 });
  });

  it("maps statuses to classes and a bad body to a parse error", async () => {
    const judge = (status: number, body: unknown = {}) =>
      createOpenAiJudge({
        model: "m",
        baseUrl: "https://x.example",
        apiKey: "k",
        fetch: fetchStub(() => ({ status, body })).fetch,
      });
    expect(await errorClass(judge(429).judge(BLOCK, { signal }))).toBe("throttled");
    expect(await errorClass(judge(401).judge(BLOCK, { signal }))).toBe("no_credentials");
    expect(await errorClass(judge(403).judge(BLOCK, { signal }))).toBe("no_credentials");
    expect(await errorClass(judge(500).judge(BLOCK, { signal }))).toBe("upstream");
    expect(
      await errorClass(judge(400, { error: { message: "bad" } }).judge(BLOCK, { signal })),
    ).toBe("upstream");
    expect(
      await errorClass(
        judge(200, { choices: [{ message: { content: "no json" } }] }).judge(BLOCK, { signal }),
      ),
    ).toBe("parse_error");
    const noKey = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x.example",
      apiKey: undefined,
    });
    expect(await errorClass(noKey.judge(BLOCK, { signal }))).toBe("no_credentials");
  });

  it("classes a network failure as upstream and an abort as a timeout", async () => {
    const down = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x.example",
      apiKey: "k",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await errorClass(down.judge(BLOCK, { signal }))).toBe("upstream");
    const slow = createOpenAiJudge({
      model: "m",
      baseUrl: "https://x.example",
      apiKey: "k",
      fetch: async (_u, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    expect(await errorClass(slow.judge(BLOCK, { signal: AbortSignal.timeout(10) }))).toBe(
      "timeout",
    );
  });
});

describe("Anthropic adapter", () => {
  it("posts a Messages request and joins the text blocks; 529 is a throttle", async () => {
    const { fetch, calls } = fetchStub(() => ({
      status: 200,
      body: {
        content: [
          { type: "text", text: '{"score": 7' },
          { type: "text", text: ', "verdict": "clean"}' },
        ],
      },
    }));
    const judge = createAnthropicJudge({ model: "claude", apiKey: "k", fetch });
    expect(await judge.judge(BLOCK, { signal })).toMatchObject({ score: 7, verdict: "clean" });
    expect(calls[0]).toMatchObject({
      model: "claude",
      system: ABUSE_JUDGE_RUBRIC,
      max_tokens: 300,
      temperature: 0,
    });
    const overloaded = createAnthropicJudge({
      model: "claude",
      apiKey: "k",
      fetch: fetchStub(() => ({ status: 529, body: {} })).fetch,
    });
    expect(await errorClass(overloaded.judge(BLOCK, { signal }))).toBe("throttled");
  });
});

describe("Bedrock adapter", () => {
  function client(
    answer: () => Promise<{ output?: { message?: { content?: { text?: string }[] } } }>,
  ) {
    const commands: ConverseCommand[] = [];
    const fake: BedrockConverseClient = {
      send: async (command) => {
        commands.push(command);
        return answer();
      },
    };
    return { fake, commands };
  }

  it("converses with the rubric as the system turn at temperature zero", async () => {
    const { fake, commands } = client(async () => ({
      output: { message: { content: [{ text: '{"score": 42}' }] } },
    }));
    const judge = createBedrockJudge({
      model: "amazon.nova-lite-v1:0",
      region: "us-east-1",
      client: fake,
    });
    expect((await judge.judge(BLOCK, { signal })).score).toBe(42);
    expect(commands[0]?.input).toMatchObject({
      modelId: "amazon.nova-lite-v1:0",
      system: [{ text: ABUSE_JUDGE_RUBRIC }],
      inferenceConfig: { temperature: 0, maxTokens: 300 },
    });
  });

  it("maps the SDK's error names", async () => {
    const failing = (name: string) =>
      createBedrockJudge({
        model: "m",
        region: "r",
        client: client(async () => {
          throw Object.assign(new Error(name), { name });
        }).fake,
      });
    expect(await errorClass(failing("ThrottlingException").judge(BLOCK, { signal }))).toBe(
      "throttled",
    );
    expect(await errorClass(failing("AccessDeniedException").judge(BLOCK, { signal }))).toBe(
      "no_credentials",
    );
    expect(await errorClass(failing("UnrecognizedClientException").judge(BLOCK, { signal }))).toBe(
      "no_credentials",
    );
    expect(await errorClass(failing("ValidationException").judge(BLOCK, { signal }))).toBe(
      "upstream",
    );
    expect(await errorClass(failing("AbortError").judge(BLOCK, { signal }))).toBe("timeout");
  });
});

describe("createAbuseJudge", () => {
  it("is null when off and picks the provider otherwise", () => {
    expect(createAbuseJudge(null)).toBeNull();
    const base = {
      region: "us-east-1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      timeoutMs: 1000,
    };
    expect(
      createAbuseJudge({ ...base, provider: "bedrock", model: "amazon.nova-lite-v1:0" }),
    ).toMatchObject({ provider: "bedrock", model: "amazon.nova-lite-v1:0" });
    expect(createAbuseJudge({ ...base, provider: "openai", model: "gpt" })).toMatchObject({
      provider: "openai",
    });
    expect(createAbuseJudge({ ...base, provider: "anthropic", model: "claude" })).toMatchObject({
      provider: "anthropic",
    });
  });
});
