import { GraduatedAdmissionError, JudgeError } from "@millionsend/core";
import { describe, expect, it, vi } from "vitest";
import { serializeBoundedJudgeRequest } from "../src/abuse-judge/bounded-frame.js";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";
import { syntheticCompleteCleanAnswers } from "./fixtures/complete-judge-answers.js";

const config = {
  model: "deepseek/deepseek-v4.1-flash",
  baseUrl: "https://api.commandcode.ai/provider/v1",
  apiKey: "synthetic-test-only",
};
const response = (finish: unknown, usage?: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: finish,
          message: { content: JSON.stringify(syntheticCompleteCleanAnswers) },
        },
      ],
      usage,
    }),
  );
const signal = () => AbortSignal.timeout(2000);

describe("bounded CommandCode judge request", () => {
  it("uses finite output bound only for the qualified pair", async () => {
    for (const model of [config.model, "another/model"]) {
      let body: Record<string, unknown> | undefined;
      await createOpenAiJudge({
        ...config,
        model,
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return response("stop");
        },
      }).judge("Appointment reminder", { signal: signal() });
      expect(body?.max_tokens).toBe(model === config.model ? 2048 : undefined);
      expect(body?.reasoning_effort).toBe(model === config.model ? "off" : undefined);
    }
  });
  for (const finish of ["length", "content_filter", "unknown", null, undefined]) {
    it(`rejects valid-looking CLEAN JSON with finish ${String(finish)}`, async () => {
      const judge = createOpenAiJudge({ ...config, fetch: async () => response(finish) });
      await expect(judge.judge("Appointment reminder", { signal: signal() })).rejects.toMatchObject(
        { class: "parse_error" },
      );
    });
  }
  it("rejects oversized metadata before fetch without silently cropping", async () => {
    const fetch = vi.fn(async () => response("stop"));
    const judge = createOpenAiJudge({ ...config, fetch });
    await expect(
      judge.judge(`Team metadata: ${"domain.invalid ".repeat(6000)}\nVisible text: Hi`, {
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(JudgeError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds the actual serialized UTF8 body inclusively", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ metadata: "" }));
    expect(
      Buffer.byteLength(serializeBoundedJudgeRequest({ metadata: "x".repeat(65536 - overhead) })),
    ).toBe(65536);
    expect(() => serializeBoundedJudgeRequest({ metadata: "x".repeat(65537 - overhead) })).toThrow(
      JudgeError,
    );
    expect(() => serializeBoundedJudgeRequest({ metadata: "😀".repeat(16384) })).toThrow(
      JudgeError,
    );
  });
  it("preserves budget refusal identity and never invokes fetch", async () => {
    const denial = new GraduatedAdmissionError("capacity_unavailable", "free", 100);
    const fetch = vi.fn(async () => response("stop"));
    const judge = createOpenAiJudge({
      ...config,
      beforeFetch: async () => {
        throw denial;
      },
      fetch,
    });
    await expect(judge.judge("Reminder", { signal: signal() })).rejects.toBe(denial);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports only trusted usage and retains unknown usage explicitly", async () => {
    for (const usage of [{ prompt_tokens: 12, completion_tokens: 102 }, undefined]) {
      const onUsage = vi.fn();
      const judge = createOpenAiJudge({ ...config, fetch: async () => response("stop", usage) });
      await judge.judge("Reminder", { signal: signal(), onUsage });
      expect(onUsage).toHaveBeenCalledWith(usage ? { inputTokens: 12, outputTokens: 102 } : null);
    }
  });
});
